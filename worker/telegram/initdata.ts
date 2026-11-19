/**
 * Проверка подписи Telegram WebApp initData по официальному алгоритму:
 * secret = HMAC_SHA256(key="WebAppData", msg=bot_token);
 * hash   = hex(HMAC_SHA256(key=secret, msg=data_check_string)).
 * Telegram ID берётся ТОЛЬКО из проверенной строки — данным от приложения без подписи не доверяем.
 */
import type { TgUser } from "../env";

const enc = new TextEncoder();

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const dataCheck = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  return hex(await hmac(secret, dataCheck));
}

export async function verifyInitData(
  initData: string,
  botToken: string,
  nowMs: number,
  maxAgeSec = 86_400,
): Promise<TgUser | null> {
  if (!initData || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  const fields: Record<string, string> = {};
  for (const [k, v] of params) if (k !== "hash") fields[k] = v;
  const expected = await signInitData(fields, botToken);
  if (!safeEqual(expected, hash)) return null;

  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > maxAgeSec || authDate - nowMs / 1000 > 300) return null;

  try {
    const user = JSON.parse(fields.user ?? "null");
    if (!user || typeof user.id !== "number") return null;
    return {
      id: user.id,
      first_name: String(user.first_name ?? "").slice(0, 64),
      last_name: user.last_name ? String(user.last_name).slice(0, 64) : undefined,
      username: user.username ? String(user.username).slice(0, 64) : undefined,
    };
  } catch {
    return null;
  }
}
