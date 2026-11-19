/**
 * Очередь уведомлений Telegram.
 *
 * Согласовано (раздел 9, п. 10): статусы, защита от параллельной обработки, повторы, защита от дублей.
 * Абсолютной гарантии «ровно один раз» нет: если Telegram принял сообщение, а ответ потерялся в сети,
 * повтор может дать дубль. Это редкий случай.
 *
 * Статусы: pending → sending → sent | retry | failed | blocked.
 */
import type { Deps } from "../env";
import { open, seal } from "../lib/crypto";
import { MINUTE } from "../lib/time";

export interface OutMessage {
  /** Уникальный ключ события: одно событие не ставится в очередь дважды. */
  key: string;
  chatId: number;
  method?: "sendMessage" | "sendPhoto";
  params: Record<string, unknown>;
  gameId?: number | null;
}

const AAD = "outbox";
const MAX_ATTEMPTS = 5;
const STALE_MS = 5 * MINUTE;

export async function enqueue(deps: Deps, messages: OutMessage[]): Promise<number> {
  if (!messages.length) return 0;
  const now = deps.now();
  const stmts = await Promise.all(
    messages.map(async (m) =>
      deps.db
        .prepare(
          `INSERT OR IGNORE INTO outbox (dedup_key, game_id, chat_id, payload_enc, status, next_at, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          m.key,
          m.gameId ?? null,
          m.chatId,
          await seal(deps.keys, JSON.stringify({ method: m.method ?? "sendMessage", params: m.params }), AAD),
          now,
          now,
        ),
    ),
  );
  let added = 0;
  // D1 ограничивает размер пакета, поэтому отправляем частями.
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await deps.db.batch(stmts.slice(i, i + 50));
    for (const r of res) added += r.meta.changes ?? 0;
  }
  return added;
}

interface Claimed {
  id: number;
  chat_id: number;
  payload_enc: string;
  attempts: number;
}

/** Отправляет до limit сообщений. Безопасно вызывать одновременно из нескольких мест. */
export async function processOutbox(deps: Deps, limit = 40): Promise<{ sent: number; failed: number }> {
  const now = deps.now();
  // Зависшие «отправляется» (например, Worker прервался) — обратно в очередь.
  await deps.db
    .prepare(`UPDATE outbox SET status = 'retry', next_at = ? WHERE status = 'sending' AND claimed_at < ?`)
    .bind(now, now - STALE_MS)
    .run();

  // Захват порции одной командой: параллельный запуск эти же строки уже не возьмёт.
  const claimId = crypto.randomUUID();
  const claimed = await deps.db
    .prepare(
      `UPDATE outbox SET status = 'sending', claimed_by = ?, claimed_at = ?, attempts = attempts + 1
       WHERE id IN (SELECT id FROM outbox WHERE status IN ('pending', 'retry') AND next_at <= ? ORDER BY id LIMIT ?)
         AND status IN ('pending', 'retry')
       RETURNING id, chat_id, payload_enc, attempts`,
    )
    .bind(claimId, now, now, limit)
    .all<Claimed>();

  let sent = 0;
  let failed = 0;
  const updates: D1PreparedStatement[] = [];
  for (const row of claimed.results ?? []) {
    let payload: { method: string; params: Record<string, unknown> };
    try {
      payload = JSON.parse(await open(deps.keys, row.payload_enc, AAD));
    } catch {
      updates.push(finish(deps, row.id, claimId, "failed", "decrypt"));
      failed++;
      continue;
    }
    const res = await deps.tg.call(payload.method, { ...payload.params, chat_id: row.chat_id });
    if (res.ok) {
      sent++;
      updates.push(
        deps.db
          .prepare(`UPDATE outbox SET status = 'sent', sent_at = ?, payload_enc = '', last_error = NULL WHERE id = ? AND claimed_by = ?`)
          .bind(deps.now(), row.id, claimId),
      );
      continue;
    }
    const code = res.error_code;
    if (code === 403) {
      // Человек остановил бота — больше не пытаемся, организатор увидит «не доставлено».
      updates.push(finish(deps, row.id, claimId, "blocked", "403"));
      updates.push(deps.db.prepare(`UPDATE users SET can_message = 0 WHERE id = ?`).bind(row.chat_id));
      failed++;
    } else if (code === 429) {
      const wait = (res.parameters?.retry_after ?? 5) * 1000;
      updates.push(retry(deps, row.id, claimId, now + wait, "429"));
    } else if (code === 400 || code === -1) {
      updates.push(finish(deps, row.id, claimId, "failed", String(code)));
      failed++;
    } else if (row.attempts >= MAX_ATTEMPTS) {
      updates.push(finish(deps, row.id, claimId, "failed", String(code)));
      failed++;
    } else {
      const backoff = 30_000 * 2 ** (row.attempts - 1);
      updates.push(retry(deps, row.id, claimId, now + backoff, String(code)));
    }
  }
  if (updates.length) await deps.db.batch(updates);
  return { sent, failed };
}

function finish(deps: Deps, id: number, claimId: string, status: "failed" | "blocked", err: string) {
  return deps.db
    .prepare(`UPDATE outbox SET status = ?, last_error = ?, payload_enc = '' WHERE id = ? AND claimed_by = ?`)
    .bind(status, err, id, claimId);
}

function retry(deps: Deps, id: number, claimId: string, nextAt: number, err: string) {
  return deps.db
    .prepare(`UPDATE outbox SET status = 'retry', next_at = ?, last_error = ? WHERE id = ? AND claimed_by = ?`)
    .bind(nextAt, err, id, claimId);
}
