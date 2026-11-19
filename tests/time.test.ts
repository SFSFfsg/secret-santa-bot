import { describe, expect, it } from "vitest";
import { topWishes } from "../worker/services/humor";
import { exchangeSchedule } from "../worker/services/scheduler";
import { daysUntil, daysWord, formatRu, localParts, parseLocal } from "../worker/lib/time";

describe("часовые пояса и даты", () => {
  it("местное время игры → UTC в разных поясах", () => {
    expect(parseLocal("2026-12-26T18:00", "Europe/Moscow")).toBe(Date.UTC(2026, 11, 26, 15, 0));
    expect(parseLocal("2026-12-26T18:00", "Asia/Makassar")).toBe(Date.UTC(2026, 11, 26, 10, 0)); // Бали, UTC+8
    expect(parseLocal("2026-12-26T18:00", "Asia/Dubai")).toBe(Date.UTC(2026, 11, 26, 14, 0));
    expect(parseLocal("2026-02-30T10:00", "Europe/Moscow")).toBeNull();
    expect(parseLocal("завтра", "Europe/Moscow")).toBeNull();
  });

  it("форматирование по-русски", () => {
    expect(formatRu(Date.UTC(2026, 11, 26, 15, 0), "Europe/Moscow")).toBe("26 декабря (сб), 18:00");
    expect(localParts(Date.UTC(2026, 11, 31, 22, 0), "Europe/Moscow")).toMatchObject({ y: 2027, m: 1, d: 1, hh: 1 });
    expect([1, 2, 5, 11, 21, 22].map(daysWord)).toEqual(["1 день", "2 дня", "5 дней", "11 дней", "21 день", "22 дня"]);
    expect(daysUntil(Date.UTC(2026, 11, 25, 20, 0), Date.UTC(2026, 11, 26, 15, 0), "Europe/Moscow")).toBe(1);
  });

  it("расписание напоминаний считается по поясу игры", () => {
    const g = { exchange_at: Date.UTC(2026, 11, 26, 15, 0), timezone: "Europe/Moscow", reminder_hour: 11 };
    const plan = exchangeSchedule(g);
    expect(plan.d7).toBe(Date.UTC(2026, 11, 19, 8, 0)); // 11:00 МСК
    expect(plan.d1).toBe(Date.UTC(2026, 11, 25, 8, 0));
    expect(plan.d0).toBe(Date.UTC(2026, 11, 26, 6, 0)); // 09:00 МСК
    expect(plan.guess_invite).toBe(Date.UTC(2026, 11, 26, 18, 0));
    const bali = exchangeSchedule({ ...g, timezone: "Asia/Makassar" });
    expect(bali.d1).toBe(Date.UTC(2026, 11, 25, 3, 0)); // 11:00 на Бали
  });

  it("популярные слова — только у трёх и более человек", () => {
    expect(topWishes(["Книги и кофе", "кофе", "Хочу книги", "книги про кофе"])).toEqual(["книги", "кофе"]);
    expect(topWishes(["пентхаус", "пентхаус"])).toEqual([]);
  });
});
