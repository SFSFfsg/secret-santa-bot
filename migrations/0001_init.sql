-- Тайный Санта NF Group — начальная структура базы D1.
-- Время хранится в миллисекундах UTC; часовой пояс игры — отдельным полем.

CREATE TABLE users (
    id           INTEGER PRIMARY KEY,               -- Telegram ID
    first_name   TEXT    NOT NULL DEFAULT '',
    last_name    TEXT    NOT NULL DEFAULT '',
    username     TEXT,
    started_bot  INTEGER NOT NULL DEFAULT 0,        -- нажимал ли «Старт» у бота
    can_message  INTEGER NOT NULL DEFAULT 1,        -- 0, если человек остановил бота
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE games (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    code              TEXT    NOT NULL UNIQUE,      -- код приглашения
    title             TEXT    NOT NULL,
    budget            TEXT    NOT NULL,
    place             TEXT    NOT NULL DEFAULT '',
    timezone          TEXT    NOT NULL DEFAULT 'Europe/Moscow',
    exchange_at       INTEGER NOT NULL,             -- вручение подарков
    draw_at           INTEGER,                      -- автожеребьёвка (NULL — вручную)
    reminder_hour     INTEGER NOT NULL DEFAULT 11,  -- час напоминаний по поясу игры
    organizer_id      INTEGER NOT NULL REFERENCES users(id),
    status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'drawn', 'revealed')),
    drawn_at          INTEGER,
    revealed_at       INTEGER,
    created_at        INTEGER NOT NULL
);
CREATE INDEX games_by_organizer ON games(organizer_id);
CREATE INDEX games_by_status ON games(status);

CREATE TABLE participants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    name        TEXT    NOT NULL,
    wishlist    TEXT    NOT NULL DEFAULT '',
    gift_ready  INTEGER NOT NULL DEFAULT 0,
    guess_id    INTEGER,                            -- прогноз «кто мой Санта»
    msgs_sent   INTEGER NOT NULL DEFAULT 0,
    joined_at   INTEGER NOT NULL,
    UNIQUE (game_id, user_id)                       -- дважды в одну игру не вступить
);
CREATE INDEX participants_by_user ON participants(user_id);

CREATE TABLE exclusions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    a_id    INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    b_id    INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    CHECK (a_id < b_id),
    UNIQUE (game_id, a_id, b_id)
);

-- Результаты жеребьёвки. Кто кому дарит — только в зашифрованном виде:
-- *_key — непрозрачные метки для поиска (HMAC), *_enc — зашифрованные номера (AES-GCM).
CREATE TABLE assignments (
    game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    santa_key      TEXT    NOT NULL,
    recipient_key  TEXT    NOT NULL,
    recipient_enc  TEXT    NOT NULL,
    santa_enc      TEXT    NOT NULL,
    PRIMARY KEY (game_id, santa_key),
    UNIQUE (game_id, recipient_key)
);

-- Анонимный чат. thread_key — непрозрачная метка пары, текст зашифрован.
CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    thread_key  TEXT    NOT NULL,
    from_santa  INTEGER NOT NULL,                  -- 1 — написал Санта, 0 — подопечный
    body_enc    TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    read_at     INTEGER
);
CREATE INDEX messages_by_thread ON messages(game_id, thread_key, id);

-- Очередь уведомлений Telegram. Текст зашифрован, после отправки стирается.
CREATE TABLE outbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key    TEXT    NOT NULL UNIQUE,          -- одно событие не ставится в очередь дважды
    game_id      INTEGER,
    chat_id      INTEGER NOT NULL,
    payload_enc  TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sending', 'sent', 'retry', 'failed', 'blocked')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_at      INTEGER NOT NULL,
    claimed_by   TEXT,
    claimed_at   INTEGER,
    last_error   TEXT,
    created_at   INTEGER NOT NULL,
    sent_at      INTEGER
);
CREATE INDEX outbox_due ON outbox(status, next_at);
CREATE INDEX outbox_by_game ON outbox(game_id, status);

-- Отправленные напоминания (защита от повторов).
CREATE TABLE reminders (
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (game_id, kind)
);

-- Уже обработанные сообщения от Telegram (Telegram иногда присылает повторно).
CREATE TABLE processed_updates (
    update_id  INTEGER PRIMARY KEY,
    at         INTEGER NOT NULL
);

CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
