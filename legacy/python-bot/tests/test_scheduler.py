from datetime import datetime

import pytest

from santa.app import create_bot
from santa.config import Config
from santa.db import Database
from santa.scheduler import tick
from tests.test_flow import FakeSession

ORG, A, B, C, D = 1, 2, 3, 4, 5
EXCHANGE = datetime(2026, 12, 26, 18, 0)
DRAW = datetime(2026, 12, 15, 12, 0)


@pytest.fixture
async def env(tmp_path):
    db = Database(str(tmp_path / "s.db"))
    await db.connect()
    session = FakeSession()
    config = Config(bot_token="42:TEST", reminder_hour=11, draw_animation_delay=0)
    bot = create_bot(config, session=session)
    game = await db.create_game("Санта NF", "3000", "26 декабря", ORG, exchange_at=EXCHANGE, draw_at=DRAW)
    for uid, wish in ((A, "книги"), (B, ""), (C, "кофе"), (D, "")):
        await db.add_participant(game.id, uid, f"user{uid}", None)
        if wish:
            p = await db.get_participant(game.id, uid)
            await db.update_participant(p.id, wishlist=wish)
    yield db, session, bot, config, game
    await db.close()


async def run(env, now):
    db, session, bot, config, game = env
    session.calls.clear()
    await tick(bot, db, config, now)
    return session


async def test_full_schedule(env):
    db, _, _, _, game = env

    # за неделю до жеребьёвки — тишина
    s = await run(env, datetime(2026, 12, 8, 12, 0))
    assert not s.calls

    # за сутки до жеребьёвки — напоминание про ТЗ, только тем, у кого оно пустое
    s = await run(env, datetime(2026, 12, 14, 13, 0))
    assert {c.chat_id for c in s.calls} == {B, D}
    assert "пустует" in s.texts_to(B)[0]
    s = await run(env, datetime(2026, 12, 14, 14, 0))
    assert not s.calls  # без повторов

    # время жеребьёвки — бот проводит её сам
    s = await run(env, datetime(2026, 12, 15, 12, 1))
    assert (await db.get_game(game.id)).is_drawn
    for uid in (A, B, C, D):
        assert s.photos_to(uid) and any("Сделка закрыта" in t for t in s.texts_to(uid))
    assert "Автоматическая жеребьёвка" in s.texts_to(ORG)[-1]

    # за 7 дней до сделки, в 11:00 — напоминание Сантам
    s = await run(env, datetime(2026, 12, 19, 10, 59))
    assert not s.calls
    s = await run(env, datetime(2026, 12, 19, 11, 0))
    assert "До сделки 7 дней" in s.texts_to(A)[0]
    assert len(s.calls) == 4

    # Подарок C уже готов — ему мягкое напоминание
    c = await db.get_participant(game.id, C)
    await db.set_gift_ready(c.id, True)

    # бот «спал» и пропустил d3: в день перед сделкой придёт только d1
    s = await run(env, datetime(2026, 12, 25, 12, 0))
    assert len(s.calls) == 4
    assert "До сделки 1 день" in s.texts_to(A)[0]
    assert "готов — отлично" in s.texts_to(C)[0]
    assert await db.reminder_sent(game.id, "d3")

    # утро дня сделки
    s = await run(env, datetime(2026, 12, 26, 9, 0))
    assert "Сегодня день сделки" in s.texts_to(B)[0]
    s = await run(env, datetime(2026, 12, 26, 9, 30))
    assert not s.calls

    # через 3 часа после вручения — угадайка и подсказка организатору
    s = await run(env, datetime(2026, 12, 26, 21, 0))
    assert "угадать" in s.texts_to(A)[0]
    assert "раскройте карты" in s.texts_to(ORG)[-1]
    s = await run(env, datetime(2026, 12, 27, 11, 0))
    assert not s.calls


async def test_autodraw_needs_three(env):
    db, _, _, _, game = env
    for uid in (C, D):
        p = await db.get_participant(game.id, uid)
        await db.remove_participant(p.id)
    s = await run(env, datetime(2026, 12, 15, 12, 5))
    assert "не состоялась" in s.texts_to(ORG)[-1]
    g = await db.get_game(game.id)
    assert g.is_open and g.draw_at is None
