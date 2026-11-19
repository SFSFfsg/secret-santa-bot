/** Правила игры: всё, что меняет данные, проходит через этот модуль. */
import { ApiError, type Deps, type TgUser } from "../env";
import { open, randomCode, seal, secureRandom, tag } from "../lib/crypto";
import { formatRu, isValidTimeZone, parseLocal, HOUR } from "../lib/time";
import { escapeHtml as h } from "../telegram/botapi";
import { DrawError, isValidAssignment, makeAssignment, MIN_PARTICIPANTS } from "./draw";
import { FORECASTS, LUXURY_WISH, MILESTONES, pick, topWishes } from "./humor";
import { enqueue, type OutMessage, processOutbox } from "./outbox";

export interface GameRow {
  id: number;
  code: string;
  title: string;
  budget: string;
  place: string;
  timezone: string;
  exchange_at: number;
  draw_at: number | null;
  reminder_hour: number;
  organizer_id: number;
  status: "open" | "drawn" | "revealed";
  drawn_at: number | null;
  revealed_at: number | null;
  created_at: number;
}

export interface PRow {
  id: number;
  game_id: number;
  user_id: number;
  name: string;
  wishlist: string;
  gift_ready: number;
  guess_id: number | null;
  msgs_sent: number;
  joined_at: number;
}

export const LIMITS = { title: 80, budget: 120, place: 120, name: 64, wishlist: 1500, chat: 1000, broadcast: 2000 };

// ---------- служебное ----------

function str(v: unknown, field: string, min: number, max: number): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) {
    throw new ApiError(422, min > 0 ? `«${field}»: от ${min} до ${max} символов.` : `«${field}»: не больше ${max} символов.`, "validation");
  }
  return s;
}

export async function upsertUser(deps: Deps, u: TgUser, startedBot = false): Promise<void> {
  const now = deps.now();
  await deps.db
    .prepare(
      `INSERT INTO users (id, first_name, last_name, username, started_bot, can_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name,
         username = excluded.username, updated_at = excluded.updated_at,
         started_bot = MAX(users.started_bot, excluded.started_bot),
         can_message = CASE WHEN excluded.started_bot = 1 THEN 1 ELSE users.can_message END`,
    )
    .bind(u.id, u.first_name ?? "", u.last_name ?? "", u.username ?? null, startedBot ? 1 : 0, now, now)
    .run();
}

export function canCreate(deps: Deps, userId: number): boolean {
  const ids = (deps.env.ADMIN_IDS ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length === 0 || ids.includes(String(userId));
}

export async function getGame(deps: Deps, id: number): Promise<GameRow> {
  const g = await deps.db.prepare(`SELECT * FROM games WHERE id = ?`).bind(id).first<GameRow>();
  if (!g) throw new ApiError(404, "Игра не найдена.", "not_found");
  return g;
}

async function myParticipant(deps: Deps, gameId: number, userId: number): Promise<PRow | null> {
  return deps.db.prepare(`SELECT * FROM participants WHERE game_id = ? AND user_id = ?`).bind(gameId, userId).first<PRow>();
}

export interface Access {
  game: GameRow;
  me: PRow | null;
  isOrganizer: boolean;
}

/** Проверка доступа к игре. Чужая игра выглядит как «не найдена» — не выдаём даже факт её существования. */
export async function access(deps: Deps, gameId: number, user: TgUser, need: "member" | "organizer" | "any"): Promise<Access> {
  const game = await getGame(deps, gameId);
  const me = await myParticipant(deps, gameId, user.id);
  const isOrganizer = game.organizer_id === user.id;
  if (!me && !isOrganizer) throw new ApiError(404, "Игра не найдена.", "not_found");
  if (need === "member" && !me) throw new ApiError(403, "Вы не участвуете в этой игре.", "forbidden");
  if (need === "organizer" && !isOrganizer) throw new ApiError(403, "Это может сделать только организатор.", "forbidden");
  return { game, me, isOrganizer };
}

async function participants(deps: Deps, gameId: number): Promise<PRow[]> {
  const r = await deps.db.prepare(`SELECT * FROM participants WHERE game_id = ? ORDER BY name COLLATE NOCASE, id`).bind(gameId).all<PRow>();
  return r.results ?? [];
}

async function appMarkup(deps: Deps, text: string, path: string) {
  const url = await deps.publicUrl();
  if (!url) return undefined;
  return { inline_keyboard: [[{ text, web_app: { url: `${url}/#${path}` } }]] };
}

async function notify(deps: Deps, key: string, chatId: number, text: string, gameId: number | null, button?: [string, string]): Promise<OutMessage> {
  return {
    key,
    chatId,
    gameId,
    params: {
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(button ? { reply_markup: await appMarkup(deps, button[0], button[1]) } : {}),
    },
  };
}

export function kickOutbox(deps: Deps, limit = 25) {
  deps.waitUntil(processOutbox(deps, limit).catch(() => undefined));
}

function inviteLink(bot: string, code: string): string {
  return bot ? `https://t.me/${bot}?start=join_${code}` : "";
}

// ---------- пары (только в зашифрованном виде) ----------

const santaKey = (deps: Deps, g: number, pid: number) => tag(deps.keys, `s:${g}:${pid}`);
const recipientKey = (deps: Deps, g: number, pid: number) => tag(deps.keys, `r:${g}:${pid}`);
const threadKey = (deps: Deps, g: number, santaPid: number) => tag(deps.keys, `t:${g}:${santaPid}`);

export async function recipientOf(deps: Deps, gameId: number, santaPid: number): Promise<number | null> {
  const row = await deps.db
    .prepare(`SELECT recipient_enc FROM assignments WHERE game_id = ? AND santa_key = ?`)
    .bind(gameId, await santaKey(deps, gameId, santaPid))
    .first<{ recipient_enc: string }>();
  return row ? Number(await open(deps.keys, row.recipient_enc, `a:${gameId}:r`)) : null;
}

export async function santaOf(deps: Deps, gameId: number, recipientPid: number): Promise<number | null> {
  const row = await deps.db
    .prepare(`SELECT santa_enc FROM assignments WHERE game_id = ? AND recipient_key = ?`)
    .bind(gameId, await recipientKey(deps, gameId, recipientPid))
    .first<{ santa_enc: string }>();
  return row ? Number(await open(deps.keys, row.santa_enc, `a:${gameId}:s`)) : null;
}

/** Все пары игры — только для серверных задач (раскрытие, напоминания). Никогда не отдаётся в API. */
async function allPairs(deps: Deps, gameId: number): Promise<Map<number, number>> {
  const rows = await deps.db.prepare(`SELECT recipient_enc, santa_enc FROM assignments WHERE game_id = ?`).bind(gameId).all<{
    recipient_enc: string;
    santa_enc: string;
  }>();
  const pairs = new Map<number, number>();
  for (const r of rows.results ?? []) {
    pairs.set(Number(await open(deps.keys, r.santa_enc, `a:${gameId}:s`)), Number(await open(deps.keys, r.recipient_enc, `a:${gameId}:r`)));
  }
  return pairs;
}
export { allPairs as _allPairsForServerTasks };

// ---------- просмотр ----------

export function publicGame(g: GameRow) {
  return {
    id: g.id,
    title: g.title,
    budget: g.budget,
    place: g.place,
    timezone: g.timezone,
    exchange_at: g.exchange_at,
    draw_at: g.draw_at,
    status: g.status,
  };
}

export async function listGames(deps: Deps, user: TgUser) {
  const r = await deps.db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM participants p2 WHERE p2.game_id = g.id) AS members,
              EXISTS(SELECT 1 FROM participants p3 WHERE p3.game_id = g.id AND p3.user_id = ?) AS is_member
       FROM games g
       WHERE g.organizer_id = ? OR g.id IN (SELECT game_id FROM participants WHERE user_id = ?)
       ORDER BY g.id DESC`,
    )
    .bind(user.id, user.id, user.id)
    .all<GameRow & { members: number; is_member: number }>();
  return (r.results ?? []).map((g) => ({
    ...publicGame(g),
    members: g.members,
    is_organizer: g.organizer_id === user.id,
    is_member: !!g.is_member,
  }));
}

export async function gameView(deps: Deps, a: Access) {
  const { game, me, isOrganizer } = a;
  const people = await participants(deps, game.id);
  const bot = await deps.botUsername();
  const view: Record<string, unknown> = {
    game: publicGame(game),
    is_organizer: isOrganizer,
    me: me && {
      id: me.id,
      name: me.name,
      wishlist: me.wishlist,
      gift_ready: !!me.gift_ready,
      guess_id: me.guess_id,
    },
    counts: {
      members: people.length,
      wishlists: people.filter((p) => p.wishlist.trim()).length,
    },
  };
  if (isOrganizer) {
    view.invite = { code: game.code, link: inviteLink(bot, game.code) };
    if (game.status !== "open") {
      (view.counts as any).ready = people.filter((p) => p.gift_ready).length;
      (view.counts as any).guesses = people.filter((p) => p.guess_id).length;
    }
  }
  if (me && game.status !== "open") view.unread = await unreadCounts(deps, game.id, me.id);
  return view;
}

export async function inviteView(deps: Deps, code: string, user: TgUser) {
  const game = await deps.db.prepare(`SELECT * FROM games WHERE code = ?`).bind(code).first<GameRow>();
  if (!game) throw new ApiError(404, "Приглашение не найдено. Попросите организатора прислать новую ссылку.", "not_found");
  const count = await deps.db.prepare(`SELECT COUNT(*) AS n FROM participants WHERE game_id = ?`).bind(game.id).first<{ n: number }>();
  const me = await myParticipant(deps, game.id, user.id);
  return { game: publicGame(game), members: count?.n ?? 0, already: !!me || game.organizer_id === user.id, is_member: !!me };
}

// ---------- создание и изменение игры ----------

function parseTimes(deps: Deps, body: any, tz: string, existing?: GameRow) {
  const now = deps.now();
  let exchangeAt = existing?.exchange_at ?? 0;
  if (body.exchange_local !== undefined || !existing) {
    const t = parseLocal(String(body.exchange_local ?? ""), tz);
    if (t === null) throw new ApiError(422, "Укажите дату и время вручения подарков.", "validation");
    if (t <= now) throw new ApiError(422, "Дата вручения уже прошла.", "validation");
    if (t > now + 400 * 24 * HOUR) throw new ApiError(422, "Дата вручения слишком далеко — Санта так далеко не планирует.", "validation");
    exchangeAt = t;
  }
  let drawAt = existing?.draw_at ?? null;
  if (body.draw_local !== undefined || !existing) {
    if (body.draw_local === null || body.draw_local === "" || body.draw_local === undefined) drawAt = null;
    else {
      const t = parseLocal(String(body.draw_local), tz);
      if (t === null) throw new ApiError(422, "Неверная дата жеребьёвки.", "validation");
      if (t <= now) throw new ApiError(422, "Дата жеребьёвки уже прошла.", "validation");
      drawAt = t;
    }
  }
  if (drawAt !== null && drawAt >= exchangeAt) throw new ApiError(422, "Жеребьёвка должна быть раньше вручения подарков.", "validation");
  return { exchangeAt, drawAt };
}

export async function createGame(deps: Deps, user: TgUser, body: any) {
  if (!canCreate(deps, user.id)) throw new ApiError(403, "Открывать игры могут только организаторы.", "forbidden");
  const title = str(body.title, "Название", 2, LIMITS.title);
  const budget = str(body.budget, "Бюджет", 1, LIMITS.budget);
  const place = str(body.place ?? "", "Место", 0, LIMITS.place);
  const tz = typeof body.timezone === "string" && isValidTimeZone(body.timezone) ? body.timezone : "Europe/Moscow";
  const { exchangeAt, drawAt } = parseTimes(deps, body, tz);
  await upsertUser(deps, user);
  const now = deps.now();

  let gameId = 0;
  for (let i = 0; i < 5 && !gameId; i++) {
    const res = await deps.db
      .prepare(
        `INSERT OR IGNORE INTO games (code, title, budget, place, timezone, exchange_at, draw_at, organizer_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(randomCode(), title, budget, place, tz, exchangeAt, drawAt, user.id, now)
      .run();
    if (res.meta.changes) gameId = Number(res.meta.last_row_id);
  }
  if (!gameId) throw new ApiError(500, "Не удалось создать игру, попробуйте ещё раз.");

  if (body.join !== false) {
    const name = str(body.organizer_name ?? displayName(user), "Имя", 2, LIMITS.name);
    await deps.db
      .prepare(`INSERT INTO participants (game_id, user_id, name, wishlist, joined_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(gameId, user.id, name, str(body.wishlist ?? "", "ТЗ", 0, LIMITS.wishlist), now)
      .run();
  }
  return { id: gameId };
}

export function displayName(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim().slice(0, LIMITS.name) || "Участник";
}

export async function updateGame(deps: Deps, a: Access, body: any) {
  const g = a.game;
  if (g.status === "revealed") throw new ApiError(409, "Игра завершена — параметры больше не меняются.", "conflict");
  const sets: string[] = [];
  const vals: unknown[] = [];
  const openOnly = (field: string) => {
    if (g.status !== "open") throw new ApiError(409, `После жеребьёвки поле «${field}» менять нельзя.`, "conflict");
  };
  if (body.title !== undefined) {
    openOnly("Название");
    sets.push("title = ?");
    vals.push(str(body.title, "Название", 2, LIMITS.title));
  }
  if (body.budget !== undefined) {
    openOnly("Бюджет");
    sets.push("budget = ?");
    vals.push(str(body.budget, "Бюджет", 1, LIMITS.budget));
  }
  if (body.place !== undefined) {
    sets.push("place = ?");
    vals.push(str(body.place, "Место", 0, LIMITS.place));
  }
  let tz = g.timezone;
  if (body.timezone !== undefined && body.timezone !== g.timezone) {
    openOnly("Часовой пояс");
    if (typeof body.timezone !== "string" || !isValidTimeZone(body.timezone)) throw new ApiError(422, "Неизвестный часовой пояс.", "validation");
    tz = body.timezone;
    sets.push("timezone = ?");
    vals.push(tz);
  }
  const resetKinds: string[] = [];
  if (body.exchange_local !== undefined || body.draw_local !== undefined) {
    if (body.draw_local !== undefined) openOnly("Дата жеребьёвки");
    const { exchangeAt, drawAt } = parseTimes(deps, body, tz, g);
    if (exchangeAt !== g.exchange_at) {
      sets.push("exchange_at = ?");
      vals.push(exchangeAt);
      resetKinds.push("d7", "d3", "d1", "d0", "guess_invite");
    }
    if (drawAt !== g.draw_at) {
      sets.push("draw_at = ?");
      vals.push(drawAt);
      resetKinds.push("draw_check", "autodraw");
    }
  }
  if (!sets.length) return;
  const stmts = [deps.db.prepare(`UPDATE games SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, g.id)];
  for (const k of resetKinds) stmts.push(deps.db.prepare(`DELETE FROM reminders WHERE game_id = ? AND kind = ?`).bind(g.id, k));
  await deps.db.batch(stmts);
}

export async function deleteGame(deps: Deps, a: Access) {
  const people = await participants(deps, a.game.id);
  const msgs = await Promise.all(
    people
      .filter((p) => p.user_id !== a.game.organizer_id)
      .map((p) => notify(deps, `deleted:${a.game.id}:${p.id}`, p.user_id, `❌ Организатор удалил игру «${h(a.game.title)}».`, null)),
  );
  await enqueue(deps, msgs);
  await deps.db.prepare(`DELETE FROM games WHERE id = ?`).bind(a.game.id).run();
  kickOutbox(deps);
}

// ---------- участники ----------

export async function joinGame(deps: Deps, code: string, user: TgUser, body: any) {
  const game = await deps.db.prepare(`SELECT * FROM games WHERE code = ?`).bind(code).first<GameRow>();
  if (!game) throw new ApiError(404, "Приглашение не найдено.", "not_found");
  if (game.status !== "open") throw new ApiError(409, "Жеребьёвка уже прошла — присоединиться нельзя. Напишите организатору.", "conflict");
  const name = str(body.name, "Имя", 2, LIMITS.name);
  const wishlist = str(body.wishlist ?? "", "ТЗ для Санты", 0, LIMITS.wishlist);
  await upsertUser(deps, user);
  const res = await deps.db
    .prepare(`INSERT OR IGNORE INTO participants (game_id, user_id, name, wishlist, joined_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(game.id, user.id, name, wishlist, deps.now())
    .run();
  if (!res.meta.changes) throw new ApiError(409, "Вы уже участвуете в этой игре 🙂", "already_member");
  const pid = Number(res.meta.last_row_id);
  const count = (await deps.db.prepare(`SELECT COUNT(*) AS n FROM participants WHERE game_id = ?`).bind(game.id).first<{ n: number }>())!.n;

  const msgs: OutMessage[] = [];
  if (game.organizer_id !== user.id) {
    msgs.push(
      await notify(deps, `join:${game.id}:${pid}`, game.organizer_id, `👋 <b>${h(name)}</b> заезжает в лот «${h(game.title)}». Резидентов: ${count}.`, game.id, [
        "⚙️ Управление",
        `/game/${game.id}/admin`,
      ]),
    );
  }
  if (MILESTONES[count]) msgs.push(await notify(deps, `milestone:${game.id}:${count}`, game.organizer_id, MILESTONES[count], game.id));
  await enqueue(deps, msgs);
  kickOutbox(deps, 5);
  return { id: game.id, lucky13: count === 13, luxury: LUXURY_WISH.test(wishlist) };
}

export async function updateMe(deps: Deps, a: Access, body: any) {
  const me = a.me!;
  const g = a.game;
  const out: Record<string, unknown> = {};
  const msgs: OutMessage[] = [];
  if (body.name !== undefined) {
    const name = str(body.name, "Имя", 2, LIMITS.name);
    await deps.db.prepare(`UPDATE participants SET name = ? WHERE id = ?`).bind(name, me.id).run();
  }
  if (body.wishlist !== undefined) {
    const wish = str(body.wishlist, "ТЗ для Санты", 0, LIMITS.wishlist);
    await deps.db.prepare(`UPDATE participants SET wishlist = ? WHERE id = ?`).bind(wish, me.id).run();
    out.luxury = LUXURY_WISH.test(wish);
    if (g.status === "drawn" && wish !== me.wishlist) {
      const santa = await santaOf(deps, g.id, me.id);
      const santaRow = santa ? await deps.db.prepare(`SELECT user_id FROM participants WHERE id = ?`).bind(santa).first<{ user_id: number }>() : null;
      if (santaRow) {
        const bucket = Math.floor(deps.now() / (10 * 60_000));
        msgs.push(
          await notify(deps, `wish:${g.id}:${me.id}:${bucket}`, santaRow.user_id, `🔔 Ваш подопечный обновил ТЗ для Санты (игра «${h(g.title)}»).`, g.id, [
            "🎯 Открыть",
            `/game/${g.id}/recipient`,
          ]),
        );
      }
    }
  }
  if (body.gift_ready !== undefined) {
    if (g.status !== "drawn") throw new ApiError(409, "Отметить подарок можно после жеребьёвки и до раскрытия карт.", "conflict");
    const ready = !!body.gift_ready;
    await deps.db.prepare(`UPDATE participants SET gift_ready = ? WHERE id = ?`).bind(ready ? 1 : 0, me.id).run();
    if (ready) {
      const rec = await recipientOf(deps, g.id, me.id);
      const recRow = rec ? await deps.db.prepare(`SELECT user_id FROM participants WHERE id = ?`).bind(rec).first<{ user_id: number }>() : null;
      if (recRow) {
        msgs.push(
          await notify(deps, `ready:${g.id}:${me.id}`, recRow.user_id, `👀 Инсайд из «${h(g.title)}»: ваш Тайный Санта сообщает, что подарок готов!`, g.id),
        );
      }
    }
  }
  if (msgs.length) {
    await enqueue(deps, msgs);
    kickOutbox(deps, 5);
  }
  return out;
}

export async function leaveGame(deps: Deps, a: Access) {
  if (a.game.status !== "open") throw new ApiError(409, "После жеребьёвки выйти нельзя — напишите организатору.", "conflict");
  await deps.db.prepare(`DELETE FROM participants WHERE id = ?`).bind(a.me!.id).run();
  if (a.game.organizer_id !== a.me!.user_id) {
    await enqueue(deps, [await notify(deps, `leave:${a.game.id}:${a.me!.id}`, a.game.organizer_id, `🚪 <b>${h(a.me!.name)}</b> выходит из игры «${h(a.game.title)}».`, a.game.id)]);
    kickOutbox(deps, 5);
  }
}

export async function membersView(deps: Deps, a: Access) {
  const people = await participants(deps, a.game.id);
  const users = await deps.db
    .prepare(`SELECT u.id, u.can_message, u.started_bot FROM users u WHERE u.id IN (SELECT user_id FROM participants WHERE game_id = ?)`)
    .bind(a.game.id)
    .all<{ id: number; can_message: number; started_bot: number }>();
  const reach = new Map((users.results ?? []).map((u) => [u.id, u.can_message === 1 && u.started_bot === 1]));
  // Организатор видит только факт заполнения ТЗ, но не его содержание.
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    has_wishlist: !!p.wishlist.trim(),
    reachable: reach.get(p.user_id) ?? false,
    is_organizer: p.user_id === a.game.organizer_id,
  }));
}

/** Имена участников — для выбора в угадайке и исключениях. Без вишлистов и Telegram-данных. */
export async function peopleView(deps: Deps, a: Access) {
  return (await participants(deps, a.game.id)).map((p) => ({ id: p.id, name: p.name }));
}

export async function kick(deps: Deps, a: Access, pid: number) {
  if (a.game.status !== "open") throw new ApiError(409, "После жеребьёвки удалять участников нельзя.", "conflict");
  const p = await deps.db.prepare(`SELECT * FROM participants WHERE id = ? AND game_id = ?`).bind(pid, a.game.id).first<PRow>();
  if (!p) throw new ApiError(404, "Участник не найден.", "not_found");
  await deps.db.prepare(`DELETE FROM participants WHERE id = ?`).bind(pid).run();
  if (p.user_id !== a.game.organizer_id) {
    await enqueue(deps, [await notify(deps, `kick:${a.game.id}:${pid}`, p.user_id, `Организатор исключил вас из игры «${h(a.game.title)}».`, a.game.id)]);
    kickOutbox(deps, 5);
  }
}

// ---------- исключения ----------

export async function exclusionsView(deps: Deps, a: Access) {
  const r = await deps.db
    .prepare(
      `SELECT e.id, pa.name AS a_name, pb.name AS b_name, e.a_id, e.b_id FROM exclusions e
       JOIN participants pa ON pa.id = e.a_id JOIN participants pb ON pb.id = e.b_id
       WHERE e.game_id = ? ORDER BY e.id`,
    )
    .bind(a.game.id)
    .all();
  return r.results ?? [];
}

export async function addExclusion(deps: Deps, a: Access, body: any) {
  if (a.game.status !== "open") throw new ApiError(409, "После жеребьёвки исключения не меняются.", "conflict");
  const x = Number(body.a_id);
  const y = Number(body.b_id);
  if (!x || !y || x === y) throw new ApiError(422, "Выберите двух разных участников.", "validation");
  const both = await deps.db
    .prepare(`SELECT COUNT(*) AS n FROM participants WHERE game_id = ? AND id IN (?, ?)`)
    .bind(a.game.id, x, y)
    .first<{ n: number }>();
  if (both?.n !== 2) throw new ApiError(404, "Участник не найден.", "not_found");
  const [lo, hi] = x < y ? [x, y] : [y, x];
  const res = await deps.db.prepare(`INSERT OR IGNORE INTO exclusions (game_id, a_id, b_id) VALUES (?, ?, ?)`).bind(a.game.id, lo, hi).run();
  return { added: !!res.meta.changes };
}

export async function deleteExclusion(deps: Deps, a: Access, id: number) {
  if (a.game.status !== "open") throw new ApiError(409, "После жеребьёвки исключения не меняются.", "conflict");
  await deps.db.prepare(`DELETE FROM exclusions WHERE id = ? AND game_id = ?`).bind(id, a.game.id).run();
}

// ---------- жеребьёвка ----------

export interface DrawCheck {
  ok: boolean;
  error?: string;
  count: number;
  no_wishlist: string[];
  unreachable: string[];
}

/** Проверка перед жеребьёвкой (п. 7): число участников, исключения (пробный расчёт без сохранения), кто без ТЗ, кому бот не напишет. */
export async function drawCheck(deps: Deps, game: GameRow): Promise<DrawCheck> {
  const people = await participants(deps, game.id);
  const ex = await deps.db.prepare(`SELECT a_id, b_id FROM exclusions WHERE game_id = ?`).bind(game.id).all<{ a_id: number; b_id: number }>();
  const users = await deps.db
    .prepare(`SELECT id, can_message, started_bot FROM users WHERE id IN (SELECT user_id FROM participants WHERE game_id = ?)`)
    .bind(game.id)
    .all<{ id: number; can_message: number; started_bot: number }>();
  const reach = new Map((users.results ?? []).map((u) => [u.id, u.can_message === 1 && u.started_bot === 1]));
  const result: DrawCheck = {
    ok: true,
    count: people.length,
    no_wishlist: people.filter((p) => !p.wishlist.trim()).map((p) => p.name),
    unreachable: people.filter((p) => !reach.get(p.user_id)).map((p) => p.name),
  };
  if (game.status !== "open") return { ...result, ok: false, error: "Жеребьёвка уже проведена." };
  try {
    makeAssignment(
      people.map((p) => p.id),
      (ex.results ?? []).map((e) => [e.a_id, e.b_id]),
      secureRandom,
    );
  } catch (e) {
    if (e instanceof DrawError) return { ...result, ok: false, error: e.message };
    throw e;
  }
  return result;
}

/** Проводит жеребьёвку. Повторный и одновременный запуск не создают вторую жеребьёвку. */
export async function performDraw(deps: Deps, game: GameRow): Promise<{ count: number }> {
  if (game.status !== "open") throw new ApiError(409, "Жеребьёвка уже проведена.", "conflict");
  const people = await participants(deps, game.id);
  if (people.length < MIN_PARTICIPANTS) {
    throw new ApiError(422, `Для жеребьёвки нужно минимум ${MIN_PARTICIPANTS} участника, сейчас ${people.length}.`, "draw_impossible");
  }
  const ex = await deps.db.prepare(`SELECT a_id, b_id FROM exclusions WHERE game_id = ?`).bind(game.id).all<{ a_id: number; b_id: number }>();
  const ids = people.map((p) => p.id);
  const exclusions = (ex.results ?? []).map((e) => [e.a_id, e.b_id] as [number, number]);
  let pairs: Map<number, number>;
  try {
    pairs = makeAssignment(ids, exclusions, secureRandom);
  } catch (e) {
    if (e instanceof DrawError) throw new ApiError(422, e.message, "draw_impossible");
    throw e;
  }
  if (!isValidAssignment(ids, exclusions, pairs)) throw new ApiError(500, "Внутренняя ошибка жеребьёвки — пары не сохранены.");

  const g = game.id;
  const rows = await Promise.all(
    [...pairs.entries()].map(async ([s, r]) => ({
      sk: await santaKey(deps, g, s),
      rk: await recipientKey(deps, g, r),
      re: await seal(deps.keys, String(r), `a:${g}:r`),
      se: await seal(deps.keys, String(s), `a:${g}:s`),
    })),
  );
  rows.sort(() => secureRandom() - 0.5); // порядок строк в базе ничего не выдаёт
  const now = deps.now();
  const stmts = rows.map((row) =>
    deps.db
      .prepare(
        `INSERT INTO assignments (game_id, santa_key, recipient_key, recipient_enc, santa_enc)
         SELECT ?, ?, ?, ?, ? WHERE (SELECT status FROM games WHERE id = ?) = 'open'`,
      )
      .bind(g, row.sk, row.rk, row.re, row.se, g),
  );
  stmts.push(deps.db.prepare(`UPDATE games SET status = 'drawn', drawn_at = ? WHERE id = ? AND status = 'open'`).bind(now, g));
  let res: D1Result[];
  try {
    res = await deps.db.batch(stmts);
  } catch {
    // Одновременный второй запуск упирается в уникальность строк — вся операция откатывается.
    throw new ApiError(409, "Жеребьёвка уже проведена.", "conflict");
  }
  if (!res[res.length - 1].meta.changes) throw new ApiError(409, "Жеребьёвка уже проведена.", "conflict");

  const byId = new Map(people.map((p) => [p.id, p]));
  const when = formatRu(game.exchange_at, game.timezone);
  const msgs: OutMessage[] = [];
  for (const [s, r] of pairs) {
    const santa = byId.get(s)!;
    const rec = byId.get(r)!;
    msgs.push(
      await notify(
        deps,
        `draw:${g}:${s}`,
        santa.user_id,
        `🤝 <b>Сделка закрыта!</b>\n\nИгра «${h(game.title)}». Вы — Тайный Санта для: <tg-spoiler><b>${h(rec.name)}</b></tg-spoiler>\n` +
          `💰 Бюджет: ${h(game.budget)}\n📅 Вручение: ${h(when)}${game.place ? ` · ${h(game.place)}` : ""}\n\nГриф «строго конфиденциально» 🤫`,
        g,
        ["🎯 Мой подопечный", `/game/${g}/recipient`],
      ),
    );
  }
  msgs.push(
    await notify(deps, `drawn-org:${g}`, game.organizer_id, `✅ Жеребьёвка в «${h(game.title)}» проведена: ${people.length} участников получают подопечных. Кто кому дарит — знает только бот 🤫`, g, [
      "⚙️ Управление",
      `/game/${g}/admin`,
    ]),
  );
  await enqueue(deps, msgs);
  kickOutbox(deps, 25);
  return { count: people.length };
}

export async function recipientView(deps: Deps, a: Access) {
  if (a.game.status === "open") throw new ApiError(409, "Жеребьёвка ещё не проведена.", "conflict");
  const r = await recipientOf(deps, a.game.id, a.me!.id);
  if (!r) throw new ApiError(404, "Подопечный не найден.", "not_found");
  const p = await deps.db.prepare(`SELECT name, wishlist FROM participants WHERE id = ?`).bind(r).first<{ name: string; wishlist: string }>();
  return { name: p?.name ?? "—", wishlist: p?.wishlist ?? "", contract: `${a.game.id}-${String(a.me!.id).padStart(4, "0")}` };
}

// ---------- анонимный чат ----------

type Thread = "recipient" | "santa";

async function threadFor(deps: Deps, a: Access, thread: Thread) {
  if (a.game.status === "open") throw new ApiError(409, "Переписка откроется после жеребьёвки.", "conflict");
  const me = a.me!;
  if (thread === "recipient") {
    const other = await recipientOf(deps, a.game.id, me.id);
    if (!other) throw new ApiError(404, "Собеседник не найден.", "not_found");
    return { key: await threadKey(deps, a.game.id, me.id), iAmSanta: true, otherPid: other };
  }
  const santa = await santaOf(deps, a.game.id, me.id);
  if (!santa) throw new ApiError(404, "Собеседник не найден.", "not_found");
  return { key: await threadKey(deps, a.game.id, santa), iAmSanta: false, otherPid: santa };
}

export async function chatView(deps: Deps, a: Access, thread: Thread, after = 0) {
  const t = await threadFor(deps, a, thread);
  const rows = await deps.db
    .prepare(`SELECT id, from_santa, body_enc, created_at FROM messages WHERE game_id = ? AND thread_key = ? AND id > ? ORDER BY id LIMIT 200`)
    .bind(a.game.id, t.key, after)
    .all<{ id: number; from_santa: number; body_enc: string; created_at: number }>();
  const messages = [];
  for (const m of rows.results ?? []) {
    messages.push({
      id: m.id,
      mine: (m.from_santa === 1) === t.iAmSanta,
      text: await open(deps.keys, m.body_enc, `m:${a.game.id}`),
      at: m.created_at,
    });
  }
  // Входящие помечаем прочитанными.
  await deps.db
    .prepare(`UPDATE messages SET read_at = ? WHERE game_id = ? AND thread_key = ? AND from_santa = ? AND read_at IS NULL`)
    .bind(deps.now(), a.game.id, t.key, t.iAmSanta ? 0 : 1)
    .run();
  let counterpart: string | null = null;
  // Имя собеседника: подопечного Санта знает всегда; Санту — только после раскрытия карт.
  if (thread === "recipient" || a.game.status === "revealed") {
    counterpart = (await deps.db.prepare(`SELECT name FROM participants WHERE id = ?`).bind(t.otherPid).first<{ name: string }>())?.name ?? null;
  }
  return { messages, counterpart, revealed: a.game.status === "revealed" };
}

async function unreadCounts(deps: Deps, gameId: number, myPid: number) {
  const out = { recipient: 0, santa: 0 };
  const mine = await threadKey(deps, gameId, myPid);
  const santa = await santaOf(deps, gameId, myPid);
  const r1 = await deps.db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE game_id = ? AND thread_key = ? AND from_santa = 0 AND read_at IS NULL`)
    .bind(gameId, mine)
    .first<{ n: number }>();
  out.recipient = r1?.n ?? 0;
  if (santa) {
    const r2 = await deps.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE game_id = ? AND thread_key = ? AND from_santa = 1 AND read_at IS NULL`)
      .bind(gameId, await threadKey(deps, gameId, santa))
      .first<{ n: number }>();
    out.santa = r2?.n ?? 0;
  }
  return out;
}

export async function sendChat(deps: Deps, a: Access, thread: Thread, body: any) {
  const text = str(body.text, "Сообщение", 1, LIMITS.chat);
  const t = await threadFor(deps, a, thread);
  const me = a.me!;
  // Защита от спама: не больше 30 сообщений за 10 минут.
  const recent = await deps.db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE game_id = ? AND thread_key = ? AND from_santa = ? AND created_at > ?`)
    .bind(a.game.id, t.key, t.iAmSanta ? 1 : 0, deps.now() - 10 * 60_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= 30) throw new ApiError(429, "Слишком много сообщений подряд — передохните пару минут.", "rate_limited");

  const res = await deps.db
    .prepare(`INSERT INTO messages (game_id, thread_key, from_santa, body_enc, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(a.game.id, t.key, t.iAmSanta ? 1 : 0, await seal(deps.keys, text, `m:${a.game.id}`), deps.now())
    .run();
  await deps.db.prepare(`UPDATE participants SET msgs_sent = msgs_sent + 1 WHERE id = ?`).bind(me.id).run();

  const other = await deps.db.prepare(`SELECT user_id FROM participants WHERE id = ?`).bind(t.otherPid).first<{ user_id: number }>();
  if (other) {
    const revealed = a.game.status === "revealed";
    const who = t.iAmSanta ? (revealed ? `Ваш Санта ${h(me.name)}` : "Ваш Тайный Санта") : revealed ? `${h(me.name)}, ваш подопечный,` : "Ваш подопечный";
    const otherThread: Thread = t.iAmSanta ? "santa" : "recipient";
    await enqueue(deps, [
      await notify(deps, `chat:${res.meta.last_row_id}`, other.user_id, `💌 ${who} пишет вам (игра «${h(a.game.title)}»).`, a.game.id, [
        "💬 Открыть чат",
        `/game/${a.game.id}/chat/${otherThread}`,
      ]),
    ]);
    kickOutbox(deps, 3);
  }
  return { id: Number(res.meta.last_row_id) };
}

// ---------- угадайка и раскрытие ----------

export async function setGuess(deps: Deps, a: Access, body: any) {
  if (a.game.status !== "drawn") throw new ApiError(409, a.game.status === "open" ? "Угадывать можно после жеребьёвки." : "Карты уже раскрыты.", "conflict");
  const pid = Number(body.participant_id);
  if (!pid || pid === a.me!.id) throw new ApiError(422, "Выберите другого участника.", "validation");
  const p = await deps.db.prepare(`SELECT id FROM participants WHERE id = ? AND game_id = ?`).bind(pid, a.game.id).first();
  if (!p) throw new ApiError(404, "Участник не найден.", "not_found");
  await deps.db.prepare(`UPDATE participants SET guess_id = ? WHERE id = ?`).bind(pid, a.me!.id).run();
}

async function nominations(deps: Deps, game: GameRow, people: PRow[], pairs: Map<number, number>) {
  const santaOfR = new Map([...pairs.entries()].map(([s, r]) => [r, s]));
  const byId = new Map(people.map((p) => [p.id, p]));
  const analysts = people.filter((p) => p.guess_id && p.guess_id === santaOfR.get(p.id)).map((p) => p.name);
  const masters = people
    .filter((p) => santaOfR.has(p.id) && p.guess_id !== santaOfR.get(p.id))
    .map((p) => byId.get(santaOfR.get(p.id)!)?.name)
    .filter(Boolean) as string[];
  const broker = [...people].sort((x, y) => y.msgs_sent - x.msgs_sent)[0];
  return {
    analysts,
    masters,
    broker: broker && broker.msgs_sent > 0 ? { name: broker.name, messages: broker.msgs_sent } : null,
  };
}

export async function reveal(deps: Deps, a: Access) {
  const g = a.game;
  if (g.status !== "drawn") throw new ApiError(409, g.status === "open" ? "Сначала нужна жеребьёвка." : "Карты уже раскрыты.", "conflict");
  const res = await deps.db.prepare(`UPDATE games SET status = 'revealed', revealed_at = ? WHERE id = ? AND status = 'drawn'`).bind(deps.now(), g.id).run();
  if (!res.meta.changes) throw new ApiError(409, "Карты уже раскрыты.", "conflict");
  const people = await participants(deps, g.id);
  const pairs = await allPairs(deps, g.id);
  const nom = await nominations(deps, g, people, pairs);
  const santaOfR = new Map([...pairs.entries()].map(([s, r]) => [r, s]));
  const byId = new Map(people.map((p) => [p.id, p]));
  const nomText =
    `\n\n🏆 <b>Номинации года</b>\n🎯 Аналитики года: ${nom.analysts.length ? h(nom.analysts.join(", ")) : "рынок оказался непредсказуем"}` +
    (nom.masters.length ? `\n🕶 Мастера конспирации: ${h(nom.masters.join(", "))}` : "") +
    (nom.broker ? `\n💬 Брокер года: ${h(nom.broker.name)} — ${nom.broker.messages}` : "");
  const msgs: OutMessage[] = [];
  for (const p of people) {
    const santa = byId.get(santaOfR.get(p.id)!);
    if (!santa) continue;
    const verdict = !p.guess_id ? "Вы не делали прогноз — рынок непредсказуем 🙂" : p.guess_id === santa.id ? "🎯 Вы угадали — аналитик года!" : "🕶 Не угадали — конспирация класса А+!";
    msgs.push(
      await notify(deps, `reveal:${g.id}:${p.id}`, p.user_id, `🎭 <b>Карты раскрыты!</b>\n\nВашим Тайным Сантой был(а) <b>${h(santa.name)}</b>.\n${verdict}${nomText}`, g.id, [
        "🎭 Итоги игры",
        `/game/${g.id}`,
      ]),
    );
  }
  if (!byId.size || !people.some((p) => p.user_id === g.organizer_id)) {
    msgs.push(await notify(deps, `reveal-org:${g.id}`, g.organizer_id, `🎭 Карты в «${h(g.title)}» раскрыты.${nomText}`, g.id));
  }
  await enqueue(deps, msgs);
  kickOutbox(deps, 25);
}

export async function resultsView(deps: Deps, a: Access) {
  if (a.game.status !== "revealed") throw new ApiError(409, "Карты ещё не раскрыты 🤫", "conflict");
  const people = await participants(deps, a.game.id);
  const pairs = await allPairs(deps, a.game.id);
  const nom = await nominations(deps, a.game, people, pairs);
  let mySanta: string | null = null;
  let guessed: boolean | null = null;
  if (a.me) {
    const s = [...pairs.entries()].find(([, r]) => r === a.me!.id)?.[0];
    mySanta = people.find((p) => p.id === s)?.name ?? null;
    guessed = a.me.guess_id ? a.me.guess_id === s : null;
  }
  return { my_santa: mySanta, guessed, nominations: nom };
}

// ---------- организатор: рассылка, напоминание, отчёт ----------

export async function broadcast(deps: Deps, a: Access, body: any) {
  const text = str(body.text, "Сообщение", 1, LIMITS.broadcast);
  const people = await participants(deps, a.game.id);
  const stamp = deps.now();
  const msgs = await Promise.all(
    people
      .filter((p) => p.user_id !== a.game.organizer_id)
      .map((p) => notify(deps, `bc:${a.game.id}:${stamp}:${p.id}`, p.user_id, `📢 <b>Организатор «${h(a.game.title)}»:</b>\n\n${h(text)}`, a.game.id, ["🎄 Открыть игру", `/game/${a.game.id}`])),
  );
  const n = await enqueue(deps, msgs);
  kickOutbox(deps, 25);
  return { queued: n };
}

export async function nudgeWishlists(deps: Deps, game: GameRow, keySuffix: string): Promise<number> {
  const people = await participants(deps, game.id);
  const msgs = await Promise.all(
    people
      .filter((p) => !p.wishlist.trim())
      .map((p) =>
        notify(
          deps,
          `nudge:${game.id}:${keySuffix}:${p.id}`,
          p.user_id,
          `🔔 <b>Ваше ТЗ для Санты пустует</b>\n\nИгра «${h(game.title)}».${game.draw_at ? ` Жеребьёвка — ${h(formatRu(game.draw_at, game.timezone))}.` : ""}\nСанте будет проще, если вы напишете хотя бы пару идей.`,
          game.id,
          ["✏️ Заполнить ТЗ", `/game/${game.id}/wishlist`],
        ),
      ),
  );
  return enqueue(deps, msgs);
}

export async function reportView(deps: Deps, a: Access) {
  const g = a.game;
  const people = await participants(deps, g.id);
  const n = people.length || 1;
  const withWish = people.filter((p) => p.wishlist.trim()).length;
  const ready = people.filter((p) => p.gift_ready).length;
  const talks = people.reduce((s, p) => s + p.msgs_sent, 0);
  const delivery = await deps.db
    .prepare(`SELECT status, COUNT(*) AS n FROM outbox WHERE game_id = ? GROUP BY status`)
    .bind(g.id)
    .all<{ status: string; n: number }>();
  const report: Record<string, unknown> = {
    members: people.length,
    wishlist_pct: Math.round((100 * withWish) / n),
    wishlists: withWish,
    ready_pct: g.status === "open" ? null : Math.round((100 * ready) / n),
    ready,
    talks,
    top_words: topWishes(people.map((p) => p.wishlist), 3),
    forecast: pick(FORECASTS),
    guesses: people.filter((p) => p.guess_id).length,
    delivery: Object.fromEntries((delivery.results ?? []).map((r) => [r.status, r.n])),
  };
  if (g.status === "revealed") report.nominations = await nominations(deps, g, people, await allPairs(deps, g.id));
  return report;
}
