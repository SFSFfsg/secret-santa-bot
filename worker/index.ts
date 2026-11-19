/** Точка входа Worker: API приложения, webhook бота, проверка настройки и будильник. */
import { handleApi, json } from "./api/router";
import { ApiError, type Deps, type Env } from "./env";
import { ConfigError, loadKeys, type Keys } from "./lib/crypto";
import { tick } from "./services/scheduler";
import { setupConnect, setupStatus } from "./setup";
import { realTelegram, type TelegramApi } from "./telegram/botapi";
import { handleWebhook } from "./telegram/webhook";

export interface DepsOverrides {
  now?: () => number;
  tg?: TelegramApi;
}

export async function makeDeps(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, o: DepsOverrides = {}): Promise<Deps> {
  let keys: Keys | null = null;
  try {
    keys = await loadKeys(env.ENCRYPTION_KEY);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
  }
  const settings = new Map<string, string>();
  const setting = async (key: string) => {
    if (!settings.has(key)) {
      const r = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
      settings.set(key, r?.value ?? "");
    }
    return settings.get(key)!;
  };
  return {
    env,
    db: env.DB,
    now: o.now ?? (() => Date.now()),
    tg: o.tg ?? realTelegram(env.BOT_TOKEN),
    get keys(): Keys {
      if (!keys) throw new ApiError(503, "Сервер ещё не настроен: нет ключа шифрования.", "not_configured");
      return keys;
    },
    waitUntil: (p) => ctx.waitUntil(p),
    publicUrl: () => setting("public_url"),
    botUsername: () => setting("bot_username"),
  };
}

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext, o: DepsOverrides = {}): Promise<Response> {
  const path = new URL(request.url).pathname;
  const deps = await makeDeps(env, ctx, o);
  if (path.startsWith("/api/")) return handleApi(request, deps);
  if (path === "/tg/webhook" && request.method === "POST") return handleWebhook(request, deps);
  if (path === "/setup/status" && request.method === "GET") return setupStatus(request, deps);
  if (path === "/setup/connect" && request.method === "POST") return setupConnect(request, deps);
  if (path === "/health") return json({ ok: true });
  return env.ASSETS.fetch(request);
}

export async function handleScheduled(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, o: DepsOverrides = {}): Promise<void> {
  if (!env.BOT_TOKEN || !env.ENCRYPTION_KEY) return; // ещё не настроено
  await tick(await makeDeps(env, ctx, o));
}

export default {
  fetch: (request, env, ctx) => handleFetch(request, env, ctx),
  scheduled: (_controller, env, ctx) => handleScheduled(env, ctx),
} satisfies ExportedHandler<Env>;
