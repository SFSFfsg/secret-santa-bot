"""Хранилище на SQLite."""

import secrets
import string
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import aiosqlite

from .dates import from_db, to_db

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    NOT NULL UNIQUE,
    title         TEXT    NOT NULL,
    budget        TEXT    NOT NULL,
    exchange_date TEXT    NOT NULL,
    organizer_id  INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'open',   -- open | drawn | revealed
    exchange_at   TEXT,                              -- 2026-12-26T18:00, местное время
    place         TEXT    NOT NULL DEFAULT '',
    draw_at       TEXT,                              -- автожеребьёвка
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    username   TEXT,
    wishlist   TEXT    NOT NULL DEFAULT '',
    gift_ready INTEGER NOT NULL DEFAULT 0,
    guess_id   INTEGER,
    msgs_sent  INTEGER NOT NULL DEFAULT 0,
    joined_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (game_id, user_id)
);

CREATE TABLE IF NOT EXISTS exclusions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    a_id    INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    b_id    INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    UNIQUE (game_id, a_id, b_id)
);

CREATE TABLE IF NOT EXISTS assignments (
    game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    santa_id     INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    PRIMARY KEY (game_id, santa_id),
    UNIQUE (game_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS reminders (
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    kind    TEXT    NOT NULL,
    sent_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (game_id, kind)
);
"""

# Колонки, добавленные после первой версии: для уже существующих баз.
MIGRATIONS = {
    "games": {
        "exchange_at": "TEXT",
        "place": "TEXT NOT NULL DEFAULT ''",
        "draw_at": "TEXT",
    },
    "participants": {
        "gift_ready": "INTEGER NOT NULL DEFAULT 0",
        "guess_id": "INTEGER",
        "msgs_sent": "INTEGER NOT NULL DEFAULT 0",
    },
}

CODE_ALPHABET = string.ascii_letters + string.digits

STATUS_OPEN = "open"
STATUS_DRAWN = "drawn"
STATUS_REVEALED = "revealed"


@dataclass
class Game:
    id: int
    code: str
    title: str
    budget: str
    exchange_date: str
    organizer_id: int
    status: str
    exchange_at: datetime | None = None
    place: str = ""
    draw_at: datetime | None = None

    @property
    def is_open(self) -> bool:
        return self.status == STATUS_OPEN

    @property
    def is_drawn(self) -> bool:
        """Жеребьёвка проведена (в том числе если карты уже раскрыты)."""
        return self.status in (STATUS_DRAWN, STATUS_REVEALED)

    @property
    def is_revealed(self) -> bool:
        return self.status == STATUS_REVEALED


@dataclass
class Participant:
    id: int
    game_id: int
    user_id: int
    name: str
    username: str | None
    wishlist: str
    gift_ready: bool = False
    guess_id: int | None = None
    msgs_sent: int = 0


@dataclass
class Exclusion:
    id: int
    a: Participant
    b: Participant


def _game(row) -> Game | None:
    if row is None:
        return None
    return Game(row["id"], row["code"], row["title"], row["budget"],
                row["exchange_date"], row["organizer_id"], row["status"],
                from_db(row["exchange_at"]), row["place"] or "", from_db(row["draw_at"]))


def _participant(row, prefix: str = "") -> Participant | None:
    if row is None:
        return None
    p = prefix
    keys = row.keys()
    return Participant(row[p + "id"], row[p + "game_id"], row[p + "user_id"],
                       row[p + "name"], row[p + "username"], row[p + "wishlist"],
                       bool(row[p + "gift_ready"]) if p + "gift_ready" in keys else False,
                       row[p + "guess_id"] if p + "guess_id" in keys else None,
                       row[p + "msgs_sent"] if p + "msgs_sent" in keys else 0)


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.execute("PRAGMA foreign_keys = ON")
        await self.conn.executescript(SCHEMA)
        for table, columns in MIGRATIONS.items():
            existing = {r["name"] for r in await self._all(f"PRAGMA table_info({table})")}
            for column, ddl in columns.items():
                if column not in existing:
                    await self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        await self.conn.commit()

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()
            self.conn = None

    async def _one(self, sql: str, args=()):
        async with self.conn.execute(sql, args) as cur:
            return await cur.fetchone()

    async def _all(self, sql: str, args=()):
        async with self.conn.execute(sql, args) as cur:
            return await cur.fetchall()

    # ---------- игры ----------

    async def create_game(self, title: str, budget: str, exchange_date: str, organizer_id: int,
                          exchange_at: datetime | None = None, place: str = "",
                          draw_at: datetime | None = None) -> Game:
        while True:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(10))
            if not await self._one("SELECT 1 FROM games WHERE code = ?", (code,)):
                break
        cur = await self.conn.execute(
            """INSERT INTO games (code, title, budget, exchange_date, organizer_id, exchange_at, place, draw_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (code, title, budget, exchange_date, organizer_id, to_db(exchange_at), place, to_db(draw_at)),
        )
        await self.conn.commit()
        return await self.get_game(cur.lastrowid)

    async def get_game(self, game_id: int) -> Game | None:
        return _game(await self._one("SELECT * FROM games WHERE id = ?", (game_id,)))

    async def get_game_by_code(self, code: str) -> Game | None:
        return _game(await self._one("SELECT * FROM games WHERE code = ?", (code,)))

    async def list_user_games(self, user_id: int) -> list[Game]:
        rows = await self._all(
            """SELECT DISTINCT g.* FROM games g
               LEFT JOIN participants p ON p.game_id = g.id AND p.user_id = ?
               WHERE g.organizer_id = ? OR p.id IS NOT NULL
               ORDER BY g.id DESC""",
            (user_id, user_id),
        )
        return [_game(r) for r in rows]

    async def update_game(self, game_id: int, **fields) -> None:
        allowed = {"title", "budget", "exchange_date", "exchange_at", "place", "draw_at"}
        sets = [(k, to_db(v) if isinstance(v, datetime) else v) for k, v in fields.items() if k in allowed]
        if not sets:
            return
        sql = "UPDATE games SET " + ", ".join(f"{k} = ?" for k, _ in sets) + " WHERE id = ?"
        await self.conn.execute(sql, [v for _, v in sets] + [game_id])
        await self.conn.commit()

    async def list_active_games(self) -> list[Game]:
        rows = await self._all("SELECT * FROM games WHERE status IN (?, ?) ORDER BY id", (STATUS_OPEN, STATUS_DRAWN))
        return [_game(r) for r in rows]

    async def delete_game(self, game_id: int) -> None:
        await self.conn.execute("DELETE FROM games WHERE id = ?", (game_id,))
        await self.conn.commit()

    # ---------- участники ----------

    async def add_participant(self, game_id: int, user_id: int, name: str, username: str | None) -> Participant:
        await self.conn.execute(
            """INSERT INTO participants (game_id, user_id, name, username) VALUES (?, ?, ?, ?)
               ON CONFLICT (game_id, user_id) DO UPDATE SET name = excluded.name, username = excluded.username""",
            (game_id, user_id, name, username),
        )
        await self.conn.commit()
        return await self.get_participant(game_id, user_id)

    async def get_participant(self, game_id: int, user_id: int) -> Participant | None:
        return _participant(await self._one(
            "SELECT * FROM participants WHERE game_id = ? AND user_id = ?", (game_id, user_id)))

    async def get_participant_by_id(self, participant_id: int) -> Participant | None:
        return _participant(await self._one("SELECT * FROM participants WHERE id = ?", (participant_id,)))

    async def list_participants(self, game_id: int) -> list[Participant]:
        rows = await self._all("SELECT * FROM participants WHERE game_id = ? ORDER BY name COLLATE NOCASE", (game_id,))
        return [_participant(r) for r in rows]

    async def update_participant(self, participant_id: int, *, name: str | None = None, wishlist: str | None = None) -> None:
        if name is not None:
            await self.conn.execute("UPDATE participants SET name = ? WHERE id = ?", (name, participant_id))
        if wishlist is not None:
            await self.conn.execute("UPDATE participants SET wishlist = ? WHERE id = ?", (wishlist, participant_id))
        await self.conn.commit()

    async def set_gift_ready(self, participant_id: int, ready: bool) -> None:
        await self.conn.execute("UPDATE participants SET gift_ready = ? WHERE id = ?", (int(ready), participant_id))
        await self.conn.commit()

    async def set_guess(self, participant_id: int, guess_id: int) -> None:
        await self.conn.execute("UPDATE participants SET guess_id = ? WHERE id = ?", (guess_id, participant_id))
        await self.conn.commit()

    async def count_message(self, participant_id: int) -> None:
        await self.conn.execute("UPDATE participants SET msgs_sent = msgs_sent + 1 WHERE id = ?", (participant_id,))
        await self.conn.commit()

    async def remove_participant(self, participant_id: int) -> None:
        await self.conn.execute("DELETE FROM participants WHERE id = ?", (participant_id,))
        await self.conn.commit()

    # ---------- исключения ----------

    async def add_exclusion(self, game_id: int, a_id: int, b_id: int) -> bool:
        if a_id == b_id:
            return False
        a_id, b_id = sorted((a_id, b_id))
        cur = await self.conn.execute(
            "INSERT OR IGNORE INTO exclusions (game_id, a_id, b_id) VALUES (?, ?, ?)", (game_id, a_id, b_id))
        await self.conn.commit()
        return cur.rowcount > 0

    async def list_exclusions(self, game_id: int) -> list[Exclusion]:
        rows = await self._all(
            """SELECT e.id AS eid,
                      a.id AS a_id, a.game_id AS a_game_id, a.user_id AS a_user_id, a.name AS a_name,
                      a.username AS a_username, a.wishlist AS a_wishlist,
                      b.id AS b_id, b.game_id AS b_game_id, b.user_id AS b_user_id, b.name AS b_name,
                      b.username AS b_username, b.wishlist AS b_wishlist
               FROM exclusions e
               JOIN participants a ON a.id = e.a_id
               JOIN participants b ON b.id = e.b_id
               WHERE e.game_id = ? ORDER BY e.id""",
            (game_id,),
        )
        return [Exclusion(r["eid"], _participant(r, "a_"), _participant(r, "b_")) for r in rows]

    async def delete_exclusion(self, game_id: int, exclusion_id: int) -> None:
        await self.conn.execute("DELETE FROM exclusions WHERE id = ? AND game_id = ?", (exclusion_id, game_id))
        await self.conn.commit()

    # ---------- жеребьёвка ----------

    async def save_draw(self, game_id: int, pairs: dict[int, int]) -> bool:
        """Атомарно сохраняет результат. False — если жеребьёвка уже проведена."""
        try:
            await self.conn.execute("BEGIN IMMEDIATE")
            cur = await self.conn.execute(
                "UPDATE games SET status = ? WHERE id = ? AND status = ?", (STATUS_DRAWN, game_id, STATUS_OPEN))
            if cur.rowcount != 1:
                await self.conn.rollback()
                return False
            await self.conn.executemany(
                "INSERT INTO assignments (game_id, santa_id, recipient_id) VALUES (?, ?, ?)",
                [(game_id, s, r) for s, r in pairs.items()],
            )
            await self.conn.commit()
            return True
        except Exception:
            await self.conn.rollback()
            raise

    async def get_recipient(self, game_id: int, santa_id: int) -> Participant | None:
        return _participant(await self._one(
            """SELECT p.* FROM assignments a JOIN participants p ON p.id = a.recipient_id
               WHERE a.game_id = ? AND a.santa_id = ?""", (game_id, santa_id)))

    async def get_santa(self, game_id: int, recipient_id: int) -> Participant | None:
        return _participant(await self._one(
            """SELECT p.* FROM assignments a JOIN participants p ON p.id = a.santa_id
               WHERE a.game_id = ? AND a.recipient_id = ?""", (game_id, recipient_id)))

    async def all_assignments(self, game_id: int) -> dict[int, int]:
        rows = await self._all("SELECT santa_id, recipient_id FROM assignments WHERE game_id = ?", (game_id,))
        return {r["santa_id"]: r["recipient_id"] for r in rows}

    async def reveal(self, game_id: int) -> bool:
        cur = await self.conn.execute(
            "UPDATE games SET status = ? WHERE id = ? AND status = ?", (STATUS_REVEALED, game_id, STATUS_DRAWN))
        await self.conn.commit()
        return cur.rowcount == 1

    # ---------- напоминания ----------

    async def mark_reminder(self, game_id: int, kind: str) -> bool:
        """Помечает напоминание отправленным. False — если уже было."""
        cur = await self.conn.execute("INSERT OR IGNORE INTO reminders (game_id, kind) VALUES (?, ?)", (game_id, kind))
        await self.conn.commit()
        return cur.rowcount == 1

    async def reminder_sent(self, game_id: int, kind: str) -> bool:
        return bool(await self._one("SELECT 1 FROM reminders WHERE game_id = ? AND kind = ?", (game_id, kind)))

    async def reset_reminders(self, game_id: int, kinds: list[str]) -> None:
        await self.conn.executemany("DELETE FROM reminders WHERE game_id = ? AND kind = ?", [(game_id, k) for k in kinds])
        await self.conn.commit()
