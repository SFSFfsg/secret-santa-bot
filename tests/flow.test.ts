import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { webhookSecret } from "../worker/telegram/webhook";
import { api, APP, BOT_TOKEN, cron, DAY, initData, local, makeCtx, raw, type Ctx } from "./helpers";
import { resetDb } from "./helpers";

beforeEach(resetDb);

const ORG = 100, ANYA = 101, BORYA = 102, VERA = 103, GLEB = 104, STRANGER = 999;

async function connect(c: Ctx) {
  const res = await raw(c, new Request(`${APP}/setup/connect`, { method: "POST" }));
  expect(res.status).toBe(200);
}

async function newGame(c: Ctx, extra: Record<string, unknown> = {}) {
  const r = await api(c, ORG, "POST", "/api/games", {
    title: "Санта NF Group 2026",
    budget: "до 3000 ₽",
    place: "Переговорная «Москва-Сити»",
    timezone: "Europe/Moscow",
    exchange_local: local(c.clock.t + 30 * DAY),
    organizer_name: "Олег Орг",
    wishlist: "Носки с оленями",
    ...extra,
  });
  expect(r.status, r.raw).toBe(200);
  return r.body.id as number;
}

async function inviteCode(c: Ctx, gameId: number) {
  const r = await api(c, ORG, "GET", `/api/games/${gameId}`);
  return r.body.invite.code as string;
}

async function join(c: Ctx, user: number, code: string, name: string, wishlist = "") {
  const r = await api(c, user, "POST", `/api/invite/${code}/join`, { name, wishlist });
  expect(r.status, r.raw).toBe(200);
  return r.body;
}

describe("полная игра через API", () => {
  it("от создания до раскрытия карт, с проверкой анонимности и прав", async () => {
    const c = makeCtx();
    await connect(c);
    const all: string[] = []; // все ответы API организатору — для проверки утечек
    const gid = await newGame(c);
    const code = await inviteCode(c, gid);

    // приглашение видно, вступление работает, повторно — нельзя
    const inv = await api(c, ANYA, "GET", `/api/invite/${code}`);
    expect(inv.body).toMatchObject({ members: 1, already: false });
    await join(c, ANYA, code, "Аня", "Книги, настолки. Не дарить <свечи> & сладкое");
    expect((await api(c, ANYA, "POST", `/api/invite/${code}/join`, { name: "Аня" })).status).toBe(409);
    const borya = await join(c, BORYA, code, "Боря", "Хочу пентхаус на Патриарших");
    expect(borya.luxury).toBe(true);
    await join(c, VERA, code, "Вера");
    expect(c.tg.to(ORG).some((t) => t.includes("Аня") && t.includes("заезжает"))).toBe(true);

    // чужой человек не видит игру; поддельная подпись не проходит
    expect((await api(c, STRANGER, "GET", `/api/games/${gid}`)).status).toBe(404);
    const forged = (await initData(STRANGER)).replace(/user=[^&]+/, `user=${encodeURIComponent(JSON.stringify({ id: ORG, first_name: "x" }))}`);
    expect((await api(c, STRANGER, "GET", `/api/games/${gid}`, undefined, `tma ${forged}`)).status).toBe(401);
    expect((await api(c, ORG, "GET", `/api/me`, undefined, "tma garbage")).status).toBe(401);
    const old = await initData(ORG, "Old", Math.floor(c.clock.t / 1000) - 2 * 86_400);
    expect((await api(c, ORG, "GET", `/api/me`, undefined, `tma ${old}`)).status).toBe(401);

    // участник не может управлять игрой
    expect((await api(c, ANYA, "GET", `/api/games/${gid}/members`)).status).toBe(403);
    expect((await api(c, ANYA, "POST", `/api/games/${gid}/draw`, { confirm: true })).status).toBe(403);
    expect((await api(c, ANYA, "GET", `/api/games/${gid}/report`)).status).toBe(403); // NF Research — только организатору

    // организатор видит факт заполнения ТЗ, но не содержание
    const members = await api(c, ORG, "GET", `/api/games/${gid}/members`);
    all.push(members.raw);
    expect(members.body).toHaveLength(4);
    expect(members.raw).not.toContain("свечи");
    expect(members.body.find((m: any) => m.name === "Вера").has_wishlist).toBe(false);

    // напоминание про ТЗ — только Вере
    await api(c, ORG, "POST", `/api/games/${gid}/nudge`);
    expect(c.tg.to(VERA).some((t) => t.includes("ТЗ для Санты пустует"))).toBe(true);
    expect(c.tg.to(ANYA).some((t) => t.includes("пустует"))).toBe(false);

    // Глеб вступает и выходит
    await join(c, GLEB, code, "Глеб");
    expect((await api(c, GLEB, "DELETE", `/api/games/${gid}/me`)).status).toBe(200);

    // исключение: Аня и Боря не дарят друг другу
    const people = (await api(c, ORG, "GET", `/api/games/${gid}/people`)).body as Array<{ id: number; name: string }>;
    const pid = (n: string) => people.find((p) => p.name === n)!.id;
    expect((await api(c, ORG, "POST", `/api/games/${gid}/exclusions`, { a_id: pid("Аня"), b_id: pid("Боря") })).body.added).toBe(true);
    expect((await api(c, ORG, "POST", `/api/games/${gid}/exclusions`, { a_id: pid("Боря"), b_id: pid("Аня") })).body.added).toBe(false);

    // проверка перед жеребьёвкой и обязательное подтверждение
    const check = await api(c, ORG, "GET", `/api/games/${gid}/draw/check`);
    expect(check.body).toMatchObject({ ok: true, count: 4, no_wishlist: ["Вера"] });
    expect((await api(c, ORG, "POST", `/api/games/${gid}/draw`, {})).status).toBe(422);
    const draw = await api(c, ORG, "POST", `/api/games/${gid}/draw`, { confirm: true });
    all.push(draw.raw);
    expect(draw.status, draw.raw).toBe(200);
    expect((await api(c, ORG, "POST", `/api/games/${gid}/draw`, { confirm: true })).status).toBe(409);

    // каждый видит только своего подопечного; правила соблюдены
    const users = { [ORG]: "Олег Орг", [ANYA]: "Аня", [BORYA]: "Боря", [VERA]: "Вера" } as Record<number, string>;
    const recipientOf: Record<string, string> = {};
    for (const [uid, name] of Object.entries(users)) {
      const r = await api(c, Number(uid), "GET", `/api/games/${gid}/recipient`);
      expect(r.status).toBe(200);
      recipientOf[name] = r.body.name;
      if (Number(uid) === ORG) all.push(r.raw);
    }
    expect(Object.values(recipientOf).sort()).toEqual(Object.values(users).sort());
    for (const [s, r] of Object.entries(recipientOf)) {
      expect(r).not.toBe(s);
      expect(recipientOf[r]).not.toBe(s); // нет взаимных пар
    }
    expect(recipientOf["Аня"]).not.toBe("Боря");
    expect(recipientOf["Боря"]).not.toBe("Аня");
    const santaOf = Object.fromEntries(Object.entries(recipientOf).map(([s, r]) => [r, s]));
    const uidOf = (name: string) => Number(Object.entries(users).find(([, n]) => n === name)![0]);

    // уведомления о жеребьёвке ушли каждому Санте, имя — под спойлером
    for (const [uid, name] of Object.entries(users)) {
      expect(c.tg.to(Number(uid)).some((t) => t.includes("Сделка закрыта") && t.includes(`<tg-spoiler><b>${recipientOf[name]}</b>`))).toBe(true);
    }

    // анонимный чат: подопечный не видит имени Санты
    const anyaRec = recipientOf["Аня"];
    expect((await api(c, ANYA, "POST", `/api/games/${gid}/chat/recipient`, { text: "Какой у тебя размер?" })).status).toBe(200);
    const recView = await api(c, uidOf(anyaRec), "GET", `/api/games/${gid}/chat/santa`);
    expect(recView.body.messages).toEqual([expect.objectContaining({ mine: false, text: "Какой у тебя размер?" })]);
    expect(recView.body.counterpart).toBeNull();
    expect(recView.raw).not.toContain("Аня");
    expect(c.tg.to(uidOf(anyaRec)).some((t) => t.includes("Ваш Тайный Санта пишет"))).toBe(true);
    await api(c, uidOf(anyaRec), "POST", `/api/games/${gid}/chat/santa`, { text: "M, спасибо!" });
    const anyaView = await api(c, ANYA, "GET", `/api/games/${gid}/chat/recipient`);
    expect(anyaView.body.messages.map((m: any) => [m.mine, m.text])).toEqual([[true, "Какой у тебя размер?"], [false, "M, спасибо!"]]);
    expect(anyaView.body.counterpart).toBe(anyaRec);

    // «подарок готов» → инсайд подопечному без имени Санты
    await api(c, ANYA, "PATCH", `/api/games/${gid}/me`, { gift_ready: true });
    const insider = c.tg.to(uidOf(anyaRec)).find((t) => t.includes("подарок готов"));
    expect(insider).toBeDefined();
    expect(insider).not.toContain("Аня");

    // Вера дописывает ТЗ — её Санта получает уведомление
    await api(c, VERA, "PATCH", `/api/games/${gid}/me`, { wishlist: "Растение в горшке" });
    expect(c.tg.to(uidOf(santaOf["Вера"])).some((t) => t.includes("обновил ТЗ"))).toBe(true);

    // организатор: сводка и отчёт без пар
    const view = await api(c, ORG, "GET", `/api/games/${gid}`);
    all.push(view.raw);
    expect(view.body.counts).toMatchObject({ members: 4, ready: 1 });
    const report = await api(c, ORG, "GET", `/api/games/${gid}/report`);
    all.push(report.raw);
    expect(report.body).toMatchObject({ members: 4, talks: 2 });
    expect(report.body.nominations).toBeUndefined();

    // угадайка: Аня угадывает, Боря ошибается
    expect((await api(c, ANYA, "POST", `/api/games/${gid}/guess`, { participant_id: pid(santaOf["Аня"]) })).status).toBe(200);
    expect((await api(c, ANYA, "POST", `/api/games/${gid}/guess`, { participant_id: pid("Аня") })).status).toBe(422);
    const wrong = Object.values(users).find((n) => n !== "Боря" && n !== santaOf["Боря"])!;
    await api(c, BORYA, "POST", `/api/games/${gid}/guess`, { participant_id: pid(wrong) });

    // результаты до раскрытия недоступны
    expect((await api(c, ANYA, "GET", `/api/games/${gid}/results`)).status).toBe(409);

    // ни один ответ организатору не выдаёт чужие пары
    for (const text of all) {
      for (const [s, r] of Object.entries(recipientOf)) {
        if (s === "Олег Орг") continue;
        expect(text.includes(`"${s}"`) && text.includes(`"${r}"`) && text.includes("recipient")).toBe(false);
      }
    }

    // раскрытие требует подтверждения и проходит один раз
    expect((await api(c, ORG, "POST", `/api/games/${gid}/reveal`, {})).status).toBe(422);
    expect((await api(c, ORG, "POST", `/api/games/${gid}/reveal`, { confirm: true })).status).toBe(200);
    expect((await api(c, ORG, "POST", `/api/games/${gid}/reveal`, { confirm: true })).status).toBe(409);
    const res = await api(c, ANYA, "GET", `/api/games/${gid}/results`);
    expect(res.body).toMatchObject({ my_santa: santaOf["Аня"], guessed: true });
    expect(res.body.nominations.analysts).toContain("Аня");
    expect(c.tg.to(BORYA).some((t) => t.includes("Карты раскрыты") && t.includes("Не угадали"))).toBe(true);

    // в базе — только зашифрованные связи
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM assignments").all()).results,
      (await env.DB.prepare("SELECT * FROM messages").all()).results,
      (await env.DB.prepare("SELECT payload_enc FROM outbox").all()).results,
    ]);
    for (const name of ["Аня", "Боря", "Вера", "Олег", "размер", "спасибо"]) expect(dump).not.toContain(name);

    // удаление игры — с подтверждением, участники получают уведомление
    expect((await api(c, ORG, "DELETE", `/api/games/${gid}`, {})).status).toBe(422);
    expect((await api(c, ORG, "DELETE", `/api/games/${gid}`, { confirm: true })).status).toBe(200);
    expect((await api(c, ANYA, "GET", `/api/games/${gid}`)).status).toBe(404);
    expect(c.tg.to(BORYA).some((t) => t.includes("удалил игру"))).toBe(true);
  });

  it("данные разных игр изолированы", async () => {
    const c = makeCtx();
    const g1 = await newGame(c);
    const r2 = await api(c, ANYA, "POST", "/api/games", { title: "Другая игра", budget: "500", exchange_local: local(c.clock.t + 10 * DAY) });
    const g2 = r2.body.id;
    await join(c, BORYA, await inviteCode(c, g1), "Боря");
    expect((await api(c, BORYA, "GET", `/api/games/${g2}`)).status).toBe(404);
    expect((await api(c, ANYA, "GET", `/api/games/${g1}/members`)).status).toBe(404);
    expect((await api(c, ANYA, "GET", `/api/games/${g1}/people`)).status).toBe(404);
    const mine = await api(c, BORYA, "GET", "/api/me");
    expect(mine.body.games.map((g: any) => g.id)).toEqual([g1]);
  });

  it("невозможная жеребьёвка не сохраняет пары и объясняет причину", async () => {
    const c = makeCtx();
    const gid = await newGame(c);
    const code = await inviteCode(c, gid);
    await join(c, ANYA, code, "Аня");
    await join(c, BORYA, code, "Боря");
    const people = (await api(c, ORG, "GET", `/api/games/${gid}/people`)).body;
    await api(c, ORG, "POST", `/api/games/${gid}/exclusions`, { a_id: people[0].id, b_id: people[1].id });
    const check = await api(c, ORG, "GET", `/api/games/${gid}/draw/check`);
    expect(check.body.ok).toBe(false);
    const r = await api(c, ORG, "POST", `/api/games/${gid}/draw`, { confirm: true });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Уберите часть исключений/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM assignments WHERE game_id = ?").bind(gid).first<{ n: number }>())!.n).toBe(0);
  });

  it("проверка входных данных", async () => {
    const c = makeCtx();
    const bad = await api(c, ORG, "POST", "/api/games", { title: "x", budget: "1", exchange_local: local(c.clock.t + DAY) });
    expect(bad.status).toBe(422);
    const past = await api(c, ORG, "POST", "/api/games", { title: "Игра", budget: "1", exchange_local: local(c.clock.t - DAY) });
    expect(past.body.error).toMatch(/прошла/);
    const order = await api(c, ORG, "POST", "/api/games", {
      title: "Игра",
      budget: "1",
      exchange_local: local(c.clock.t + DAY),
      draw_local: local(c.clock.t + 2 * DAY),
    });
    expect(order.body.error).toMatch(/раньше вручения/);
  });
});

describe("очередь уведомлений", () => {
  it("статусы, повторы, остановленный бот и защита от дублей", async () => {
    const c = makeCtx();
    const gid = await newGame(c);
    const code = await inviteCode(c, gid);
    let fail: "none" | "429" | "500" | "403" = "429";
    c.tg.responder = (call) => {
      if (call.method === "getMe") return { ok: true, result: { username: "nf_test_bot" } };
      if (fail === "429") return { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } };
      if (fail === "500") return { ok: false, error_code: 500, description: "Internal" };
      if (fail === "403" && call.params.chat_id === ORG) return { ok: false, error_code: 403, description: "blocked" };
      return { ok: true, result: {} };
    };
    await join(c, ANYA, code, "Аня");
    const row = () => env.DB.prepare("SELECT status, attempts, next_at FROM outbox WHERE dedup_key LIKE 'join:%'").first<any>();
    expect(await row()).toMatchObject({ status: "retry", attempts: 1, next_at: c.clock.t + 7000 });

    // до срока повтора не отправляется
    await cron(c);
    expect((await row()).attempts).toBe(1);
    // временная ошибка сервера — ещё одна попытка позже
    fail = "500";
    c.clock.t += 8000;
    await cron(c);
    expect(await row()).toMatchObject({ status: "retry", attempts: 2 });
    // человек остановил бота
    fail = "403";
    c.clock.t += 10 * 60_000;
    await cron(c);
    expect((await row()).status).toBe("blocked");
    expect((await env.DB.prepare("SELECT can_message FROM users WHERE id = ?").bind(ORG).first<any>()).can_message).toBe(0);

    // одно событие не попадает в очередь дважды
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<any>()).n;
    await api(c, ANYA, "PATCH", `/api/games/${gid}/me`, { wishlist: "кофе" }); // до жеребьёвки уведомлений нет
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<any>()).n).toBe(before);
  });

  it("зависшая отправка возвращается в очередь, параллельные запуски не берут одно и то же", async () => {
    const c = makeCtx();
    c.tg.responder = (x) => (x.method === "getMe" ? { ok: true, result: { username: "b" } } : { ok: false, error_code: 500, description: "x" });
    const gid = await newGame(c);
    await join(c, ANYA, await inviteCode(c, gid), "Аня");
    // имитируем запуск, который «забрал» сообщение и прервался
    await env.DB.prepare("UPDATE outbox SET status = 'sending', claimed_at = ?, claimed_by = 'dead'").bind(c.clock.t).run();
    fakeSilent(c);
    c.tg.calls = [];
    await cron(c);
    expect((await env.DB.prepare("SELECT status FROM outbox").first<any>()).status).toBe("sending"); // ещё не зависло
    expect(c.tg.calls).toHaveLength(0);
    c.clock.t += 6 * 60_000;
    await Promise.all([cron(c), cron(c)]); // два запуска одновременно
    expect((await env.DB.prepare("SELECT status FROM outbox").first<any>()).status).toBe("sent");
    expect(c.tg.calls.filter((x) => x.method === "sendMessage")).toHaveLength(1);
  });
});

function fakeSilent(c: Ctx) {
  c.tg.responder = () => ({ ok: true, result: { username: "nf_test_bot" } });
}

describe("webhook бота", () => {
  it("проверяет секрет, отвечает на /start и приглашение, не обрабатывает повтор дважды", async () => {
    const c = makeCtx();
    await connect(c);
    const gid = await newGame(c);
    const code = await inviteCode(c, gid);
    const send = async (update: unknown, secret?: string) =>
      raw(
        c,
        new Request(`${APP}/tg/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret ?? (await webhookSecret(BOT_TOKEN)) },
          body: JSON.stringify(update),
        }),
      );
    const from = { id: 555, is_bot: false, first_name: "Гость" };
    expect((await send({ update_id: 1, message: { chat: { id: 555, type: "private" }, from, text: "/start" } }, "wrong")).status).toBe(403);

    const welcome = await (await send({ update_id: 2, message: { chat: { id: 555, type: "private" }, from, text: "/start" } })).json<any>();
    expect(welcome.method).toBe("sendPhoto");
    expect(welcome.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`${APP}/#/`);

    const invite = await (await send({ update_id: 3, message: { chat: { id: 555, type: "private" }, from, text: `/start join_${code}` } })).json<any>();
    expect(invite.text).toContain("Санта NF Group 2026");
    expect(invite.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`${APP}/#/join/${code}`);

    const again = await send({ update_id: 3, message: { chat: { id: 555, type: "private" }, from, text: `/start join_${code}` } });
    expect(await again.text()).toBe("ok");

    const egg = await (await send({ update_id: 4, message: { chat: { id: 555, type: "private" }, from, text: "Хо-хо-хо" } })).json<any>();
    expect(egg.text).toContain("Брокерская лицензия");
    const user = await env.DB.prepare("SELECT started_bot FROM users WHERE id = 555").first<any>();
    expect(user.started_bot).toBe(1);
  });

  it("страница проверки не раскрывает секреты", async () => {
    const c = makeCtx();
    await connect(c);
    const res = await raw(c, new Request(`${APP}/setup/status`));
    const text = await res.text();
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain("q83vEjRb");
    expect(JSON.parse(text)).toMatchObject({ database: { ok: true }, encryption_key: { ok: true }, bot: { ok: true, username: "nf_test_bot" } });
  });
});
