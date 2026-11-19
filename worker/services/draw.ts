/**
 * Жеребьёвка: кто кому дарит.
 *
 * Правила (согласовано, раздел 9 аудита):
 *  - никто не дарит сам себе;
 *  - нет взаимных пар (А дарит Б и Б дарит А) — ни в основном, ни в запасном варианте;
 *  - пары из исключений не дарят друг другу ни в одну сторону;
 *  - каждый дарит ровно одному и получает ровно от одного;
 *  - если корректного варианта нет — ошибка, неправильные пары не создаются.
 */

export class DrawError extends Error {}

export const MIN_PARTICIPANTS = 3;

export const IMPOSSIBLE_MESSAGE =
  "С такими исключениями жеребьёвка невозможна. Уберите часть исключений или добавьте участников.";

export function makeAssignment(
  idsIn: number[],
  exclusions: Array<[number, number]>,
  rand: () => number,
  attempts = 600,
  stepLimit = 20_000,
): Map<number, number> {
  const ids = [...new Set(idsIn)];
  const n = ids.length;
  if (n < MIN_PARTICIPANTS) throw new DrawError(`Для жеребьёвки нужно минимум ${MIN_PARTICIPANTS} участника, сейчас ${n}.`);

  const banned = new Set<string>();
  for (const [a, b] of exclusions) if (a !== b) banned.add(pairKey(a, b));
  const allowed = (a: number, b: number) => a !== b && !banned.has(pairKey(a, b));

  // Быстрая проверка: у каждого должен быть хотя бы один допустимый подопечный.
  for (const a of ids) if (!ids.some((b) => allowed(a, b))) throw new DrawError(IMPOSSIBLE_MESSAGE);

  // 1. Общий круг A→B→C→…→A. При n ≥ 3 взаимных пар в нём не бывает по устройству.
  const order = [...ids];
  for (let t = 0; t < attempts; t++) {
    shuffle(order, rand);
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = allowed(order[i], order[(i + 1) % n]);
    if (ok) {
      const result = new Map<number, number>();
      for (let i = 0; i < n; i++) result.set(order[i], order[(i + 1) % n]);
      return result;
    }
  }

  // 2. Запасной вариант — перебор с теми же правилами, включая запрет взаимных пар.
  const result = backtrack(ids, allowed, rand, stepLimit);
  if (!result) throw new DrawError(IMPOSSIBLE_MESSAGE);
  return result;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function shuffle<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function backtrack(
  ids: number[],
  allowed: (a: number, b: number) => boolean,
  rand: () => number,
  stepLimit: number,
): Map<number, number> | null {
  const options = new Map(ids.map((a) => [a, ids.filter((b) => allowed(a, b))]));
  const santas = [...ids].sort((x, y) => options.get(x)!.length - options.get(y)!.length || rand() - 0.5);
  const used = new Set<number>();
  const result = new Map<number, number>();
  let steps = 0;

  const go = (i: number): boolean => {
    if (i === santas.length) return true;
    if (++steps > stepLimit) return false;
    const santa = santas[i];
    const candidates = options.get(santa)!.filter((b) => !used.has(b) && result.get(b) !== santa);
    shuffle(candidates, rand);
    for (const b of candidates) {
      used.add(b);
      result.set(santa, b);
      if (go(i + 1)) return true;
      used.delete(b);
      result.delete(santa);
    }
    return false;
  };
  return go(0) ? result : null;
}

/** Проверка результата — используется в тестах и как страховка перед сохранением. */
export function isValidAssignment(ids: number[], exclusions: Array<[number, number]>, pairs: Map<number, number>): boolean {
  if (pairs.size !== ids.length) return false;
  const banned = new Set(exclusions.map(([a, b]) => pairKey(a, b)));
  const receivers = new Set<number>();
  for (const s of ids) {
    const r = pairs.get(s);
    if (r === undefined || r === s || !ids.includes(r)) return false;
    if (banned.has(pairKey(s, r))) return false;
    if (pairs.get(r) === s) return false; // взаимная пара
    receivers.add(r);
  }
  return receivers.size === ids.length;
}
