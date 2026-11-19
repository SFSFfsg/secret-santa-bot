import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { api, APP, cron, makeCtx, raw, type Ctx } from "./helpers";
import { resetDb } from "./helpers";

beforeEach(resetDb);

const ORG = 200, A = 201, B = 202, C = 203, D = 204;

/** Игра: жеребьёвка 15.12 12:00, вручение 26.12 18:00 по Москве. Сейчас — 1 декабря. */
async function setup(c: Ctx) {
  await raw(c, new Request(`${APP}/setup/connect`, { method: "POST" }));
  const r = await api(c, ORG, "POST", "/api/games", {
    title: "Санта NF",
    budget: "3000",
    timezone: "Europe/Moscow",
    exchange_local: "2026-12-26T18:00",
    draw_local: "2026-12-15T12:00",
    join: false,
  });
  expect(r.status, r.raw).toBe(200);
  const gid = r.body.id;
  const code = (await api(c, ORG, "GET", `/api/games/${gid}`)).body.invite.code;
  for (const [u, wish] of [[A, "книги"], [B, ""], [C, "кофе"], [D, ""]] as const) {
    await api(c, u, "POST", `/api/invite/${code}/join`, { name: `user${u}`, wishlist: wish });
  }
  c.tg.calls = [];
  return gid as number;
}

const at = (iso: string) => Date.parse(iso);

async function runAt(c: Ctx, iso: string) {
  c.tg.calls = [];
  c.clock.t = at(iso);
  await cron(c);
  return c.tg.calls.filter((x) => x.method === "sendMessage");
}

describe("напоминания и автожеребьёвка", () => {
  it("полное расписание по поясу игры без лавины старых напоминаний", async () => {
    const c = makeCtx(at("2026-12-01T09:00:00Z"));
    const gid = await setup(c);

    expect(await runAt(c, "2026-12-08T09:00:00Z")).toHaveLength(0);

    // за сутки до жеребьёвки: напоминание про ТЗ (B, D) и проверка организатору
    let sent = await runAt(c, "2026-12-14T10:00:00Z");
    expect(sent.map((x) => x.params.chat_id).sort()).toEqual([B, D, ORG].sort());
    expect(c.tg.to(ORG)[0]).toContain("Проверка пройдена");
    expect(await runAt(c, "2026-12-14T11:00:00Z")).toHaveLength(0);

    // время жеребьёвки (12:00 МСК = 09:00 UTC) — проводится сама
    sent = await runAt(c, "2026-12-15T09:00:00Z");
    expect((await api(c, A, "GET", `/api/games/${gid}`)).body.game.status).toBe("drawn");
    for (const u of [A, B, C, D]) expect(c.tg.to(u).some((t) => t.includes("Сделка закрыта"))).toBe(true);

    // за 7 дней, в 11:00 по Москве (08:00 UTC)
    expect(await runAt(c, "2026-12-19T07:59:00Z")).toHaveLength(0);
    sent = await runAt(c, "2026-12-19T08:00:00Z");
    expect(sent).toHaveLength(4);
    expect(c.tg.to(A)[0]).toContain("До сделки 7 дней");
    expect(await runAt(c, "2026-12-19T08:30:00Z")).toHaveLength(0);

    // у C подарок готов — мягкий текст
    await api(c, C, "PATCH", `/api/games/${gid}/me`, { gift_ready: true });

    // будильник «проспал» напоминание за 3 дня — приходит только за 1 день
    sent = await runAt(c, "2026-12-25T09:00:00Z");
    expect(sent).toHaveLength(4);
    expect(c.tg.to(A)[0]).toContain("До сделки 1 день");
    expect(c.tg.to(C)[0]).toContain("готов — отлично");
    const marks = await env.DB.prepare("SELECT kind FROM reminders WHERE game_id = ? ORDER BY kind").bind(gid).all<any>();
    expect(marks.results.map((m: any) => m.kind)).toContain("d3");

    // утро дня вручения
    sent = await runAt(c, "2026-12-26T06:00:00Z");
    expect(c.tg.to(B)[0]).toContain("Сегодня день сделки");
    expect(await runAt(c, "2026-12-26T06:30:00Z")).toHaveLength(0);

    // через 3 часа после вручения — угадайка и подсказка организатору
    sent = await runAt(c, "2026-12-26T18:00:00Z");
    expect(c.tg.to(A)[0]).toContain("угадать");
    expect(c.tg.to(ORG).some((t) => t.includes("раскройте карты"))).toBe(true);
    expect(await runAt(c, "2026-12-27T08:00:00Z")).toHaveLength(0);
  });

  it("автожеребьёвка не запускается, если проверка не проходит", async () => {
    const c = makeCtx(at("2026-12-01T09:00:00Z"));
    const r = await api(c, ORG, "POST", "/api/games", {
      title: "Мало людей",
      budget: "1",
      exchange_local: "2026-12-26T18:00",
      draw_local: "2026-12-15T12:00",
    });
    const gid = r.body.id;
    await runAt(c, "2026-12-15T09:05:00Z");
    expect(c.tg.to(ORG).some((t) => t.includes("не запущена"))).toBe(true);
    const g = (await api(c, ORG, "GET", `/api/games/${gid}`)).body.game;
    expect(g.status).toBe("open");
    expect(g.draw_at).toBeNull();
  });

  it("смена даты вручения пересчитывает напоминания", async () => {
    const c = makeCtx(at("2026-12-01T09:00:00Z"));
    const gid = await setup(c);
    await runAt(c, "2026-12-15T09:00:00Z"); // жеребьёвка
    await runAt(c, "2026-12-19T08:00:00Z"); // d7
    c.clock.t = at("2026-12-19T10:00:00Z");
    const upd = await api(c, ORG, "PATCH", `/api/games/${gid}`, { exchange_local: "2026-12-30T18:00" });
    expect(upd.status, upd.raw).toBe(200);
    const sent = await runAt(c, "2026-12-23T08:00:00Z");
    expect(sent).toHaveLength(4);
    expect(c.tg.to(A)[0]).toContain("До сделки 7 дней");
  });
});
