/**
 * Проверка и подключение. Ничего секретного не показывает: только «есть / нет / работает».
 *  GET  /setup/status  — состояние базы, секретов, бота и webhook;
 *  POST /setup/connect — подключить бота к этому адресу (webhook, кнопка меню, команды).
 * Подключение безопасно вызывать повторно: адрес берётся из самого запроса к этому Worker.
 */
import { json } from "./api/router";
import type { Deps } from "./env";
import { loadKeys } from "./lib/crypto";
import { webhookSecret } from "./telegram/webhook";

export async function setupStatus(request: Request, deps: Deps): Promise<Response> {
  const origin = new URL(request.url).origin;
  const out: Record<string, unknown> = { app_url: origin };
  try {
    const r = await deps.db.prepare(`SELECT COUNT(*) AS n FROM games`).first<{ n: number }>();
    out.database = { ok: true, games: r?.n ?? 0 };
  } catch {
    out.database = { ok: false, hint: "База не подключена или не созданы таблицы" };
  }
  try {
    await loadKeys(deps.env.ENCRYPTION_KEY);
    out.encryption_key = { ok: true };
  } catch (e) {
    out.encryption_key = { ok: false, hint: e instanceof Error ? e.message : "ошибка" };
  }
  if (!deps.env.BOT_TOKEN) {
    out.bot = { ok: false, hint: "Не задан секрет BOT_TOKEN" };
  } else {
    const me = await deps.tg.call("getMe", {});
    if (!me.ok) out.bot = { ok: false, hint: me.error_code === 401 ? "Токен бота неверный" : "Telegram не ответил" };
    else {
      out.bot = { ok: true, username: me.result.username };
      const wh = await deps.tg.call("getWebhookInfo", {});
      const expected = `${origin}/tg/webhook`;
      out.webhook = wh.ok
        ? { ok: wh.result.url === expected, connected_to_this_app: wh.result.url === expected, pending: wh.result.pending_update_count ?? 0, last_error: wh.result.last_error_message ?? null }
        : { ok: false };
    }
  }
  return json(out);
}

export async function setupConnect(request: Request, deps: Deps): Promise<Response> {
  if (!deps.env.BOT_TOKEN) return json({ ok: false, error: "Сначала добавьте секрет BOT_TOKEN в Cloudflare." }, 400);
  try {
    await loadKeys(deps.env.ENCRYPTION_KEY);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Нет ключа шифрования" }, 400);
  }
  const origin = new URL(request.url).origin;
  const me = await deps.tg.call("getMe", {});
  if (!me.ok) return json({ ok: false, error: me.error_code === 401 ? "Токен бота неверный." : "Telegram не ответил, попробуйте ещё раз." }, 400);

  const steps: Record<string, boolean> = {};
  const wh = await deps.tg.call("setWebhook", {
    url: `${origin}/tg/webhook`,
    secret_token: await webhookSecret(deps.env.BOT_TOKEN),
    allowed_updates: ["message", "my_chat_member"],
    max_connections: 20,
  });
  steps.webhook = wh.ok;
  steps.menu = (
    await deps.tg.call("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть", web_app: { url: `${origin}/` } } })
  ).ok;
  steps.commands = (
    await deps.tg.call("setMyCommands", {
      commands: [
        { command: "start", description: "Открыть Тайного Санту" },
        { command: "help", description: "Помощь" },
      ],
    })
  ).ok;
  steps.description = (
    await deps.tg.call("setMyDescription", {
      description:
        "🎅 Тайный Санта NF Group — новогодний объект класса А+. Анонимный обмен подарками с коллегами: жеребьёвка, вишлисты, анонимный чат и немного аналитики.",
    })
  ).ok;
  await deps.db.batch([
    deps.db.prepare(`INSERT INTO settings (key, value) VALUES ('public_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(origin),
    deps.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('bot_username', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(me.result.username),
  ]);
  return json({ ok: steps.webhook, steps, bot_username: me.result.username, app_url: origin });
}
