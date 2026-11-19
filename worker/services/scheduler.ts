/**
 * Будильник (Cron Trigger, раз в минуту). Правила перенесены из scheduler.py:
 *  - за сутки до автожеребьёвки: напоминание тем, у кого пустое ТЗ, и проверка параметров организатору;
 *  - в назначенное время: автожеребьёвка (если проверка не проходит — не запускается, организатор получает объяснение);
 *  - за 7, 3 и 1 день до вручения в reminder_hour по поясу игры — Сантам;
 *  - утром в день вручения (09:00 или за 2 часа) — всем;
 *  - через 3 часа после вручения — приглашение угадать Санту и подсказка организатору.
 * Если будильник пропустил время — уходит только самое свежее напоминание, старые помечаются пропущенными.
 */
import { ApiError, type Deps } from "../env";
import { addLocalDays, atLocalTime, daysWord, formatRu, HOUR, localParts } from "../lib/time";
import { escapeHtml as h } from "../telegram/botapi";
import { _allPairsForServerTasks as allPairs, drawCheck, type GameRow, nudgeWishlists, performDraw, type PRow } from "./game";
import { enqueue, type OutMessage, processOutbox } from "./outbox";

const BEFORE: Array<[string, number]> = [
  ["d7", 7],
  ["d3", 3],
  ["d1", 1],
  ["d0", 0],
];

export function exchangeSchedule(g: Pick<GameRow, "exchange_at" | "timezone" | "reminder_hour">): Record<string, number> {
  const day = localParts(g.exchange_at, g.timezone);
  const plan: Record<string, number> = {};
  for (const [kind, n] of BEFORE) if (n) plan[kind] = atLocalTime(addLocalDays(day, -n), g.reminder_hour, 0, g.timezone);
  plan.d0 = Math.min(atLocalTime(day, 9, 0, g.timezone), g.exchange_at - 2 * HOUR);
  plan.guess_invite = g.exchange_at + 3 * HOUR;
  return plan;
}

async function mark(deps: Deps, gameId: number, kind: string): Promise<boolean> {
  const r = await deps.db.prepare(`INSERT OR IGNORE INTO reminders (game_id, kind, created_at) VALUES (?, ?, ?)`).bind(gameId, kind, deps.now()).run();
  return !!r.meta.changes;
}

async function button(deps: Deps, text: string, path: string) {
  const url = await deps.publicUrl();
  return url ? { reply_markup: { inline_keyboard: [[{ text, web_app: { url: `${url}/#${path}` } }]] } } : {};
}

async function msg(deps: Deps, key: string, chatId: number, text: string, gameId: number, btn?: [string, string]): Promise<OutMessage> {
  return {
    key,
    chatId,
    gameId,
    params: { text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(btn ? await button(deps, btn[0], btn[1]) : {}) },
  };
}

export async function tick(deps: Deps): Promise<void> {
  const now = deps.now();
  const games = await deps.db
    .prepare(`SELECT * FROM games WHERE (status = 'open' AND draw_at IS NOT NULL) OR status = 'drawn'`)
    .all<GameRow>();
  for (const game of games.results ?? []) {
    try {
      if (game.status === "open") await beforeDraw(deps, game, now);
      else await beforeExchange(deps, game, now);
    } catch (e) {
      // В журнал — только номер игры и тип ошибки, без персональных данных.
      console.error(`scheduler: game ${game.id}: ${e instanceof Error ? e.name : "error"}`);
    }
  }
  await processOutbox(deps, 40);
  if (new Date(now).getUTCMinutes() % 30 === 0) await cleanup(deps, now);
}

async function beforeDraw(deps: Deps, game: GameRow, now: number) {
  const drawAt = game.draw_at!;
  if (now >= drawAt - 24 * HOUR && now < drawAt && (await mark(deps, game.id, "draw_check"))) {
    await nudgeWishlists(deps, game, "auto");
    const c = await drawCheck(deps, game);
    const lines = [
      `🎲 <b>Автожеребьёвка в «${h(game.title)}»</b> — ${h(formatRu(drawAt, game.timezone))}.`,
      "",
      c.ok ? `✅ Проверка пройдена: ${c.count} участников, исключения позволяют жеребьёвку.` : `⚠️ Сейчас жеребьёвка не пройдёт: ${h(c.error ?? "")}`,
    ];
    if (c.no_wishlist.length) lines.push(`📝 Без ТЗ: ${h(c.no_wishlist.join(", "))} — им отправлено напоминание.`);
    if (c.unreachable.length) lines.push(`📵 Бот не сможет написать: ${h(c.unreachable.join(", "))}.`);
    lines.push("", "После жеребьёвки состав участников больше не меняется, отменить её нельзя.");
    await enqueue(deps, [await msg(deps, `drawcheck:${game.id}:${drawAt}`, game.organizer_id, lines.join("\n"), game.id, ["⚙️ Управление", `/game/${game.id}/admin`])]);
  }
  if (now < drawAt || !(await mark(deps, game.id, "autodraw"))) return;

  const c = await drawCheck(deps, game);
  if (!c.ok) {
    await deps.db.prepare(`UPDATE games SET draw_at = NULL WHERE id = ?`).bind(game.id).run();
    await enqueue(deps, [
      await msg(
        deps,
        `autodraw-fail:${game.id}:${drawAt}`,
        game.organizer_id,
        `⚠️ Автожеребьёвка в «${h(game.title)}» не запущена: ${h(c.error ?? "")}\nИсправьте и проведите её вручную.`,
        game.id,
        ["⚙️ Управление", `/game/${game.id}/admin`],
      ),
    ]);
    return;
  }
  try {
    await performDraw(deps, game);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    await enqueue(deps, [await msg(deps, `autodraw-fail:${game.id}:${drawAt}`, game.organizer_id, `⚠️ Автожеребьёвка в «${h(game.title)}»: ${h(e.message)}`, game.id)]);
  }
}

async function beforeExchange(deps: Deps, game: GameRow, now: number) {
  const plan = exchangeSchedule(game);
  if (now >= plan.guess_invite) {
    if (await mark(deps, game.id, "guess_invite")) {
      for (const [kind] of BEFORE) await mark(deps, game.id, kind);
      await guessInvite(deps, game);
    }
    return;
  }
  if (now >= game.exchange_at) return;
  const due = BEFORE.filter(([kind]) => plan[kind] <= now);
  if (!due.length) return;
  const [latest, days] = due[due.length - 1];
  if (!(await mark(deps, game.id, latest))) return;
  for (const [kind] of due.slice(0, -1)) await mark(deps, game.id, kind); // устаревшие — не шлём
  await exchangeReminder(deps, game, latest, days);
}

async function exchangeReminder(deps: Deps, game: GameRow, kind: string, days: number) {
  const people = (await deps.db.prepare(`SELECT * FROM participants WHERE game_id = ?`).bind(game.id).all<PRow>()).results ?? [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const pairs = await allPairs(deps, game.id);
  const when = h(formatRu(game.exchange_at, game.timezone)) + (game.place ? ` · ${h(game.place)}` : "");
  const msgs: OutMessage[] = [];
  for (const santa of people) {
    const rec = byId.get(pairs.get(santa.id) ?? -1);
    if (!rec) continue;
    const who = `<tg-spoiler><b>${h(rec.name)}</b></tg-spoiler>`;
    let text: string;
    if (days === 0) text = `🎉 <b>Сегодня день сделки!</b>\n\n«${h(game.title)}»\n📍 ${when}\n\nНе забудьте подарок для ${who} 🎁`;
    else if (santa.gift_ready) text = `⏳ До сделки «${h(game.title)}» — ${daysWord(days)}.\nПодарок для ${who} готов — отлично! Не забудьте взять его с собой: ${when}.`;
    else text = `⏳ <b>До сделки ${daysWord(days)}</b>\n\n«${h(game.title)}» · ${when}\nВаш подопечный — ${who}. Подарок уже готов?`;
    msgs.push(await msg(deps, `rem:${game.id}:${game.exchange_at}:${kind}:${santa.id}`, santa.user_id, text, game.id, ["🎯 Мой подопечный", `/game/${game.id}/recipient`]));
  }
  await enqueue(deps, msgs);
}

async function guessInvite(deps: Deps, game: GameRow) {
  const people = (await deps.db.prepare(`SELECT * FROM participants WHERE game_id = ?`).bind(game.id).all<PRow>()).results ?? [];
  const msgs: OutMessage[] = [];
  for (const p of people) {
    if (p.guess_id) continue;
    msgs.push(
      await msg(
        deps,
        `guess:${game.id}:${game.exchange_at}:${p.id}`,
        p.user_id,
        `🎁 Подарки вручены? Время аналитики!\n\nИгра «${h(game.title)}». Попробуйте угадать, кто был вашим Тайным Сантой. Самые точные получат номинацию «Аналитик года» 🏆`,
        game.id,
        ["🕵️ Угадать Санту", `/game/${game.id}/guess`],
      ),
    );
  }
  msgs.push(
    await msg(deps, `guess-org:${game.id}:${game.exchange_at}`, game.organizer_id, `🎭 Сделка «${h(game.title)}» состоялась! Резиденты угадывают своих Сант. Когда будете готовы — раскройте карты.`, game.id, [
      "🎭 Раскрыть карты",
      `/game/${game.id}/admin`,
    ]),
  );
  await enqueue(deps, msgs);
}

async function cleanup(deps: Deps, now: number) {
  await deps.db.batch([
    deps.db.prepare(`DELETE FROM processed_updates WHERE at < ?`).bind(now - 3 * 24 * HOUR),
    deps.db.prepare(`DELETE FROM outbox WHERE status IN ('sent', 'failed', 'blocked') AND created_at < ?`).bind(now - 30 * 24 * HOUR),
  ]);
}
