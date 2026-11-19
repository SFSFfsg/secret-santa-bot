import { describe, expect, it } from "vitest";
import { DrawError, isValidAssignment, makeAssignment } from "../worker/services/draw";

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("жеребьёвка", () => {
  it.each([3, 4, 5, 10, 50, 200])("корректна для %i участников, без взаимных пар", (n) => {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    for (let seed = 0; seed < 30; seed++) {
      const pairs = makeAssignment(ids, [], seeded(seed));
      expect(isValidAssignment(ids, [], pairs)).toBe(true);
      for (const [a, b] of pairs) expect(pairs.get(b)).not.toBe(a);
    }
  });

  it("учитывает исключения в обе стороны", () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const ex: Array<[number, number]> = [
      [1, 2],
      [3, 4],
      [5, 6],
      [1, 3],
    ];
    for (let seed = 0; seed < 100; seed++) {
      const pairs = makeAssignment(ids, ex, seeded(seed));
      expect(isValidAssignment(ids, ex, pairs)).toBe(true);
    }
  });

  it("запасной перебор тоже не создаёт взаимных пар", () => {
    // Плотные исключения: общий круг почти невозможен, работает перебор.
    const ids = [1, 2, 3, 4, 5, 6];
    const ex: Array<[number, number]> = [
      [1, 3],
      [1, 4],
      [2, 5],
      [2, 6],
      [3, 5],
      [4, 6],
    ];
    for (let seed = 0; seed < 50; seed++) {
      const pairs = makeAssignment(ids, ex, seeded(seed), 3);
      expect(isValidAssignment(ids, ex, pairs)).toBe(true);
    }
  });

  it("случай, где старый бот составлял взаимную пару, теперь даёт понятную ошибку", () => {
    // 1 и 2 могли дарить только друг другу — это взаимная пара, она запрещена.
    const ex: Array<[number, number]> = [
      [1, 3],
      [1, 4],
      [1, 5],
      [2, 3],
      [2, 4],
      [2, 5],
    ];
    expect(() => makeAssignment([1, 2, 3, 4, 5], ex, seeded(1), 50)).toThrow(/исключениями жеребьёвка невозможна/);
  });

  it("трое с одним исключением — невозможно", () => {
    expect(() => makeAssignment([1, 2, 3], [[1, 2]], seeded(1))).toThrow(DrawError);
  });

  it("меньше трёх — ошибка", () => {
    expect(() => makeAssignment([1, 2], [], seeded(1))).toThrow(/минимум 3/);
  });

  it("проверка ловит неверные результаты", () => {
    expect(isValidAssignment([1, 2, 3], [], new Map([[1, 2], [2, 1], [3, 3]]))).toBe(false);
    expect(isValidAssignment([1, 2, 3, 4], [], new Map([[1, 2], [2, 1], [3, 4], [4, 3]]))).toBe(false);
    expect(isValidAssignment([1, 2, 3], [], new Map([[1, 2], [2, 3], [3, 1]]))).toBe(true);
  });
});
