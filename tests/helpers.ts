import { env } from "cloudflare:workers";
import { handleFetch, handleScheduled } from "../worker/index";
import type { TelegramApi, TgResult } from "../worker/telegram/botapi";
import { signInitData } from "../worker/telegram/initdata";

export const BOT_TOKEN = "123456:TEST-TOKEN";
export const APP = "https://santa.example.workers.dev";

export interface TgCall {
  method: string;
  params: Record<string, any>;
}

/** Поддельный Telegram: записывает вызовы, ответы можно настроить. */
export class FakeTelegram implements TelegramApi {
  calls: TgCall[] = [];
  responder: (c: TgCall) => TgResult = (c) =>
    c.method === "getMe" ? { ok: true, result: { id: 1, is_bot: true, username: "nf_test_bot" } } : { ok: true, result: { message_id: this.calls.length } };
  async call(method: string, params: Record<string, unknown>): Promise<TgResult> {
    const c = { method, params: params as Record<string, any> };
    this.calls.push(c);
    return this.responder(c);
  }
  to(chatId: number): string[] {
    return this.calls.filter((c) => c.params.chat_id === chatId).map((c) => String(c.params.text ?? c.params.caption ?? ""));
  }
}

export class Clock {
  constructor(public t: number) {}
  now = () => this.t;
}

export interface Ctx {
  tg: FakeTelegram;
  clock: Clock;
  waits: Promise<unknown>[];
}

export function makeCtx(start = Date.UTC(2026, 10, 19, 9, 0)): Ctx {
  return { tg: new FakeTelegram(), clock: new Clock(start), waits: [] };
}

function execCtx(c: Ctx): ExecutionContext {
  return { waitUntil: (p: Promise<unknown>) => c.waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

export async function settle(c: Ctx) {
  while (c.waits.length) await Promise.all(c.waits.splice(0));
}

export async function initData(userId: number, first = `User${userId}`, authDate?: number): Promise<string> {
  const fields: Record<string, string> = {
    auth_date: String(authDate ?? Math.floor(Date.now() / 1000)),
    query_id: "AAE" + userId,
    user: JSON.stringify({ id: userId, first_name: first, username: `u${userId}` }),
  };
  const hash = await signInitData(fields, BOT_TOKEN);
  return new URLSearchParams({ ...fields, hash }).toString();
}

export async function api(c: Ctx, userId: number, method: string, path: string, body?: unknown, auth?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers.authorization = auth ?? `tma ${await initData(userId, `User${userId}`, Math.floor(c.clock.t / 1000))}`;
  const res = await handleFetch(
    new Request(`${APP}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env as any,
    execCtx(c),
    { now: c.clock.now, tg: c.tg },
  );
  await settle(c);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

export async function raw(c: Ctx, req: Request) {
  const res = await handleFetch(req, env as any, execCtx(c), { now: c.clock.now, tg: c.tg });
  await settle(c);
  return res;
}

export async function cron(c: Ctx) {
  await handleScheduled(env as any, execCtx(c), { now: c.clock.now, tg: c.tg });
  await settle(c);
}

/** Местное московское время → строка для формы. */
export function local(utcMs: number, tzOffsetHours = 3): string {
  const d = new Date(utcMs + tzOffsetHours * 3_600_000);
  return d.toISOString().slice(0, 16);
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** Чистая база перед каждым тестом. */
export async function resetDb() {
  await env.DB.batch(
    ["messages", "assignments", "exclusions", "outbox", "reminders", "processed_updates", "settings", "participants", "games", "users"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
