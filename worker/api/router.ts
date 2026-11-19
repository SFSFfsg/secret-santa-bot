/**
 * API для Mini App. Каждый запрос: проверка подписи Telegram (initData) → проверка прав → действие.
 * Ответы содержат только то, что положено запрашивающему. Пары целиком не отдаются никогда.
 */
import { ApiError, type Deps, type TgUser } from "../env";
import * as game from "../services/game";
import { verifyInitData } from "../telegram/initdata";

type Handler = (deps: Deps, user: TgUser, params: Record<string, string>, body: any, url: URL) => Promise<unknown>;

const routes: Array<[string, RegExp, Handler]> = [];
function route(method: string, pattern: string, handler: Handler) {
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
  routes.push([method, re, handler]);
}

const id = (p: Record<string, string>, k = "id") => {
  const n = Number(p[k]);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(404, "Не найдено.", "not_found");
  return n;
};
const thread = (p: Record<string, string>) => {
  if (p.thread !== "recipient" && p.thread !== "santa") throw new ApiError(404, "Не найдено.", "not_found");
  return p.thread as "recipient" | "santa";
};

route("GET", "/api/me", async (deps, user) => {
  await game.upsertUser(deps, user);
  return {
    user: { id: user.id, name: game.displayName(user) },
    can_create: game.canCreate(deps, user.id),
    bot_username: await deps.botUsername(),
    games: await game.listGames(deps, user),
  };
});
route("POST", "/api/games", (deps, user, _p, body) => game.createGame(deps, user, body));
route("GET", "/api/invite/:code", (deps, user, p) => game.inviteView(deps, p.code, user));
route("POST", "/api/invite/:code/join", (deps, user, p, body) => game.joinGame(deps, p.code, user, body));

route("GET", "/api/games/:id", async (deps, user, p) => game.gameView(deps, await game.access(deps, id(p), user, "any")));
route("PATCH", "/api/games/:id", async (deps, user, p, body) => game.updateGame(deps, await game.access(deps, id(p), user, "organizer"), body));
route("DELETE", "/api/games/:id", async (deps, user, p, body) => {
  if (body?.confirm !== true) throw new ApiError(422, "Нужно подтверждение удаления.", "confirm_required");
  return game.deleteGame(deps, await game.access(deps, id(p), user, "organizer"));
});

route("PATCH", "/api/games/:id/me", async (deps, user, p, body) => game.updateMe(deps, await game.access(deps, id(p), user, "member"), body));
route("DELETE", "/api/games/:id/me", async (deps, user, p) => game.leaveGame(deps, await game.access(deps, id(p), user, "member")));
route("GET", "/api/games/:id/recipient", async (deps, user, p) => game.recipientView(deps, await game.access(deps, id(p), user, "member")));
route("GET", "/api/games/:id/people", async (deps, user, p) => game.peopleView(deps, await game.access(deps, id(p), user, "any")));
route("GET", "/api/games/:id/chat/:thread", async (deps, user, p, _b, url) =>
  game.chatView(deps, await game.access(deps, id(p), user, "member"), thread(p), Number(url.searchParams.get("after") ?? 0) || 0),
);
route("POST", "/api/games/:id/chat/:thread", async (deps, user, p, body) => game.sendChat(deps, await game.access(deps, id(p), user, "member"), thread(p), body));
route("POST", "/api/games/:id/guess", async (deps, user, p, body) => game.setGuess(deps, await game.access(deps, id(p), user, "member"), body));
route("GET", "/api/games/:id/results", async (deps, user, p) => game.resultsView(deps, await game.access(deps, id(p), user, "any")));

// Только организатор
route("GET", "/api/games/:id/members", async (deps, user, p) => game.membersView(deps, await game.access(deps, id(p), user, "organizer")));
route("DELETE", "/api/games/:id/members/:pid", async (deps, user, p) => game.kick(deps, await game.access(deps, id(p), user, "organizer"), id(p, "pid")));
route("GET", "/api/games/:id/exclusions", async (deps, user, p) => game.exclusionsView(deps, await game.access(deps, id(p), user, "organizer")));
route("POST", "/api/games/:id/exclusions", async (deps, user, p, body) => game.addExclusion(deps, await game.access(deps, id(p), user, "organizer"), body));
route("DELETE", "/api/games/:id/exclusions/:eid", async (deps, user, p) =>
  game.deleteExclusion(deps, await game.access(deps, id(p), user, "organizer"), id(p, "eid")),
);
route("GET", "/api/games/:id/draw/check", async (deps, user, p) => game.drawCheck(deps, (await game.access(deps, id(p), user, "organizer")).game));
route("POST", "/api/games/:id/draw", async (deps, user, p, body) => {
  if (body?.confirm !== true) throw new ApiError(422, "Нужно подтверждение жеребьёвки.", "confirm_required");
  const a = await game.access(deps, id(p), user, "organizer");
  const check = await game.drawCheck(deps, a.game);
  if (!check.ok) throw new ApiError(a.game.status === "open" ? 422 : 409, check.error ?? "Жеребьёвка невозможна.", "draw_impossible");
  return game.performDraw(deps, a.game);
});
route("POST", "/api/games/:id/reveal", async (deps, user, p, body) => {
  if (body?.confirm !== true) throw new ApiError(422, "Нужно подтверждение раскрытия.", "confirm_required");
  return game.reveal(deps, await game.access(deps, id(p), user, "organizer"));
});
route("POST", "/api/games/:id/broadcast", async (deps, user, p, body) => game.broadcast(deps, await game.access(deps, id(p), user, "organizer"), body));
route("POST", "/api/games/:id/nudge", async (deps, user, p) => {
  const a = await game.access(deps, id(p), user, "organizer");
  if (a.game.status !== "open") throw new ApiError(409, "После жеребьёвки напоминание про ТЗ не нужно.", "conflict");
  const n = await game.nudgeWishlists(deps, a.game, `manual:${Math.floor(deps.now() / 3_600_000)}`);
  game.kickOutbox(deps, 25);
  return { queued: n };
});
route("GET", "/api/games/:id/report", async (deps, user, p) => game.reportView(deps, await game.access(deps, id(p), user, "organizer")));

export async function handleApi(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  try {
    const auth = request.headers.get("authorization") ?? "";
    if (!deps.env.BOT_TOKEN) throw new ApiError(503, "Сервер ещё не настроен: нет токена бота.", "not_configured");
    const user = auth.startsWith("tma ") ? await verifyInitData(auth.slice(4), deps.env.BOT_TOKEN, deps.now()) : null;
    if (!user) throw new ApiError(401, "Не удалось подтвердить вход через Telegram. Закройте и снова откройте приложение.", "unauthorized");

    for (const [method, re, handler] of routes) {
      if (method !== request.method) continue;
      const m = re.exec(url.pathname);
      if (!m) continue;
      let body: any = {};
      if (request.method !== "GET") {
        const text = await request.text();
        if (text.length > 16_384) throw new ApiError(413, "Слишком большой запрос.", "too_large");
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new ApiError(400, "Неверный формат запроса.", "bad_request");
        }
      }
      const result = await handler(deps, user, m.groups ?? {}, body, url);
      return json(result ?? { ok: true });
    }
    throw new ApiError(404, "Не найдено.", "not_found");
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message, code: e.code }, e.status);
    // Неожиданная ошибка: в журнал — только тип, без данных запроса.
    console.error(`api error: ${url.pathname.replace(/\d+/g, ":n")}: ${e instanceof Error ? e.name + " " + e.message.slice(0, 120) : "unknown"}`);
    return json({ error: "Что-то пошло не так. Попробуйте ещё раз.", code: "internal" }, 500);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
