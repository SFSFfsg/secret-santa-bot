import pytest

from santa.db import Database


@pytest.fixture
async def db(tmp_path):
    d = Database(str(tmp_path / "t.db"))
    await d.connect()
    yield d
    await d.close()


async def test_game_lifecycle(db):
    g = await db.create_game("НГ", "3000", "26.12", organizer_id=1)
    assert (await db.get_game_by_code(g.code)).id == g.id
    a = await db.add_participant(g.id, 10, "Аня", "anya")
    b = await db.add_participant(g.id, 11, "Боря", None)
    c = await db.add_participant(g.id, 12, "Вера", None)
    again = await db.add_participant(g.id, 10, "Анна", "anya")
    assert again.id == a.id and again.name == "Анна"
    assert len(await db.list_participants(g.id)) == 3

    assert await db.add_exclusion(g.id, b.id, a.id)
    assert not await db.add_exclusion(g.id, a.id, b.id)  # пара симметрична
    assert len(await db.list_exclusions(g.id)) == 1

    assert {x.id for x in await db.list_user_games(10)} == {g.id}
    assert {x.id for x in await db.list_user_games(1)} == {g.id}
    assert await db.list_user_games(999) == []

    pairs = {a.id: c.id, c.id: b.id, b.id: a.id}
    assert await db.save_draw(g.id, pairs)
    assert not await db.save_draw(g.id, pairs)  # повторно нельзя
    assert (await db.get_game(g.id)).is_drawn
    assert (await db.get_recipient(g.id, a.id)).id == c.id
    assert (await db.get_santa(g.id, a.id)).id == b.id

    await db.delete_game(g.id)
    assert await db.get_game(g.id) is None
    assert await db.list_participants(g.id) == []


async def test_remove_participant_drops_exclusions(db):
    g = await db.create_game("НГ", "3000", "26.12", organizer_id=1)
    a = await db.add_participant(g.id, 10, "Аня", None)
    b = await db.add_participant(g.id, 11, "Боря", None)
    await db.add_exclusion(g.id, a.id, b.id)
    await db.remove_participant(a.id)
    assert await db.list_exclusions(g.id) == []
