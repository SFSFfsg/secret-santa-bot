import type { Keys } from "./lib/crypto";
import type { TelegramApi } from "./telegram/botapi";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Токен бота от @BotFather — секрет Cloudflare. */
  BOT_TOKEN?: string;
  /** Ключ шифрования (32 байта в base64) — секрет Cloudflare. */
  ENCRYPTION_KEY?: string;
  /** Telegram ID организаторов через запятую. Пусто — открывать игры может любой. */
  ADMIN_IDS?: string;
}

/** Всё, что нужно бизнес-логике. В тестах подменяются время и Telegram. */
export interface Deps {
  env: Env;
  db: D1Database;
  now: () => number;
  tg: TelegramApi;
  keys: Keys;
  waitUntil: (p: Promise<unknown>) => void;
  /** Адрес приложения (https://…workers.dev) — для кнопок в сообщениях бота. */
  publicUrl: () => Promise<string>;
  botUsername: () => Promise<string>;
}

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}
