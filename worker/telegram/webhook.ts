/**
 * Webhook: Telegram сам присылает сюда каждое сообщение боту.
 * Ответ отправляется прямо в ответе на запрос Telegram — это не тратит лимит обращений Worker.
 */
import type { Deps } from "../env";
import { sha256Hex } from "../lib/crypto";
import { upsertUser } from "../services/game";
import { CAP_RATE, DUE_DILIGENCE, easterEgg } from "../services/humor";
import { escapeHtml as h } from "./botapi";

export async function webhookSecret(botToken: string): Promise<string> {
  return (await sha256Hex(`${botToken}:webhook`)).slice(0, 48);
}

const WELCOME =
  "<b>ТАЙНЫЙ САНТА · NF GROUP</b>\n\nНовогодний объект класса А+ для обмена подарками между коллегами.\n\n" +
  "Откройте приложение кнопкой ниже: там игры, ваше ТЗ для Санты, подопечный и анонимный чат. " +
  "Кто кому дарит — не знает никто, даже организатор 🤫";

export async function handleWebhook(request: Request, deps: Deps): Promise<Response> {
  const token = deps.env.BOT_TOKEN;
  if (!token) return new Response("not configured", { status: 503 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== (await webhookSecret(token))) {
    return new Response("forbidden", { status: 403 });
  }
  let update: any;
  try {
    update = await request.json();
  } catch {
    return new Response("ok");
  }
  // Telegram иногда присылает одно и то же повторно — обрабатываем один раз.
  if (typeof update.update_id === "number") {
    const r = await deps.db.prepare(`INSERT OR IGNORE INTO processed_updates (update_id, at) VALUES (?, ?)`).bind(update.update_id, deps.now()).run();
    if (!r.meta.changes) return new Response("ok");
  }

  if (update.my_chat_member?.chat?.type === "private") {
    const status = update.my_chat_member.new_chat_member?.status;
    const uid = update.my_chat_member.from?.id;
    if (uid) await deps.db.prepare(`UPDATE users SET can_message = ? WHERE id = ?`).bind(status === "kicked" ? 0 : 1, uid).run();
    return new Response("ok");
  }

  const msg = update.message;
  if (!msg || msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return new Response("ok");
  await upsertUser(deps, { id: msg.from.id, first_name: msg.from.first_name ?? "", last_name: msg.from.last_name, username: msg.from.username }, true);

  const url = (await deps.publicUrl()) || new URL(request.url).origin;
  const text: string = msg.text ?? "";
  const reply = (body: Record<string, unknown>) =>
    new Response(JSON.stringify({ method: "sendMessage", chat_id: msg.chat.id, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...body }), {
      headers: { "content-type": "application/json" },
    });
  const openButton = (label: string, path = "/") => ({ reply_markup: { inline_keyboard: [[{ text: label, web_app: { url: `${url}/#${path}` } }]] } });

  if (text.startsWith("/start")) {
    const arg = text.split(/\s+/)[1] ?? "";
    const join = /^join_([A-Za-z0-9]{6,20})$/.exec(arg);
    if (join) {
      const g = await deps.db.prepare(`SELECT title, status FROM games WHERE code = ?`).bind(join[1]).first<{ title: string; status: string }>();
      if (!g) return reply({ text: "😕 Приглашение не найдено. Попросите организатора прислать новую ссылку." });
      return reply({
        text: `🎅 <b>Приглашение в Тайного Санту</b>\n«${h(g.title)}»\n\nНажмите кнопку, чтобы посмотреть детали и присоединиться.`,
        ...openButton("✅ Открыть приглашение", `/join/${join[1]}`),
      });
    }
    return new Response(
      JSON.stringify({
        method: "sendPhoto",
        chat_id: msg.chat.id,
        photo: `${url}/img/welcome.png`,
        caption: WELCOME,
        parse_mode: "HTML",
        ...openButton("🎄 Открыть Тайного Санту"),
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  if (text.startsWith("/due_diligence") || text.startsWith("/dd")) return reply({ text: DUE_DILIGENCE });
  if (text.startsWith("/cap_rate")) return reply({ text: CAP_RATE });
  if (text.startsWith("/help")) {
    return reply({ text: "Всё управление игрой — в приложении. Откройте его кнопкой ниже.\n\n🥚 Подсказка: мы всё-таки консалтинговая компания.", ...openButton("🎄 Открыть") });
  }
  const egg = easterEgg(text);
  if (egg) return reply({ text: egg });
  return reply({ text: "Всё самое интересное — в приложении 🎄", ...openButton("🎄 Открыть Тайного Санту") });
}
