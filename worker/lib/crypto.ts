/**
 * Шифрование тайных связей: кто кому дарит и кто с кем переписывается.
 *
 * Из одного ключа (секрет ENCRYPTION_KEY, 32 байта) выводятся два:
 *  - AES-GCM — шифрует значения (номер подопечного, текст сообщения, уведомления);
 *  - HMAC-SHA256 — делает непрозрачные метки для поиска («строка Санты №12 в игре 7»),
 *    из которых без ключа нельзя понять, о каком участнике речь.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Keys {
  aes: CryptoKey;
  hmac: CryptoKey;
}

export class ConfigError extends Error {}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const keyCache = new Map<string, Promise<Keys>>();

export function loadKeys(raw: string | undefined): Promise<Keys> {
  if (!raw) throw new ConfigError("Не задан секрет ENCRYPTION_KEY");
  const cached = keyCache.get(raw);
  if (cached) return cached;
  const p = deriveKeys(raw);
  keyCache.set(raw, p);
  p.catch(() => keyCache.delete(raw));
  return p;
}

async function deriveKeys(raw: string): Promise<Keys> {
  let bytes: Uint8Array;
  try {
    bytes = fromB64(raw.trim());
  } catch {
    throw new ConfigError("ENCRYPTION_KEY должен быть в формате base64");
  }
  if (bytes.length !== 32) throw new ConfigError("ENCRYPTION_KEY должен содержать ровно 32 байта");
  const master = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  const salt = enc.encode("secret-santa-nf/v1");
  const aes = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("aes-gcm") },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const hmac = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("hmac-tags") },
    master,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  return { aes, hmac };
}

/** Шифрует строку. aad — «контекст» (например, номер игры и назначение поля): чужое значение сюда не подставить. */
export async function seal(keys: Keys, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, keys.aes, enc.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toB64(out);
}

export async function open(keys: Keys, sealed: string, aad: string): Promise<string> {
  const bytes = fromB64(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(aad) },
    keys.aes,
    bytes.slice(12),
  );
  return dec.decode(pt);
}

/** Непрозрачная метка для поиска. Без ключа по ней нельзя восстановить исходные данные. */
export async function tag(keys: Keys, label: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", keys.hmac, enc.encode(label)));
  return toB64Url(sig.slice(0, 24));
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomCode(length = 10): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

/** Криптостойкое случайное число [0, 1) — для жеребьёвки. */
export function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
}
