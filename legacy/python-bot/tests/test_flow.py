"""Сквозной сценарий: апдейты Telegram прогоняются через настоящий Dispatcher,
а запросы к Bot API перехватываются фейковой сессией."""

import itertools
from collections import Counter
from datetime import datetime

import pytest
from aiogram.client.session.base import BaseSession
from aiogram.methods import (
    AnswerCallbackQuery,
    CopyMessage,
    EditMessageReplyMarkup,
    EditMessageText,
    GetMe,
    SendMessage,
    SendPhoto,
)
from aiogram.types import CallbackQuery, Chat, Message, MessageId, PhotoSize, Update, User

from santa.app import create_bot, create_dispatcher
from santa.callbacks import G, Menu
from santa.config import Config
from santa.db import Database

ORG, ANYA, BORYA, VERA, GLEB = 1, 2, 3, 4, 5
NAMES = {ORG: "Олег Орг", ANYA: "Аня", BORYA: "Боря", VERA: "Вера", GLEB: "Глеб", 999: "Santa"}


class FakeSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.ids = itertools.count(1000)
        self.answered = Counter()

    async def close(self):
        pass

    async def stream_content(self, *a, **kw):  # pragma: no cover
        raise NotImplementedError

    async def make_request(self, bot, method, timeout=None):
        self.calls.append(method)
        if isinstance(method, GetMe):
            return User(id=999, is_bot=True, first_name="Santa", username="nf_santa_bot")
        if isinstance(method, (SendMessage, EditMessageText)):
            return Message(message_id=next(self.ids), date=datetime.now(),
                           chat=Chat(id=method.chat_id or 0, type="private"), text=method.text)
        if isinstance(method, SendPhoto):
            assert isinstance(method.photo, str) or method.photo.data.startswith(b"\x89PNG")
            fid = f"photo{next(self.ids)}"
            return Message(message_id=next(self.ids), date=datetime.now(),
                           chat=Chat(id=method.chat_id, type="private"), caption=method.caption,
                           photo=[PhotoSize(file_id=fid, file_unique_id=fid, width=1280, height=720)])
        if isinstance(method, CopyMessage):
            return MessageId(message_id=next(self.ids))
        if isinstance(method, AnswerCallbackQuery):
            self.answered[method.callback_query_id] += 1
            return True
        if isinstance(method, EditMessageReplyMarkup):
            return True
        return True

    # --- помощники для проверок ---
    def texts_to(self, chat_id):
        """Тексты и подписи к картинкам, отправленные пользователю."""
        out = []
        for c in self.calls:
            if isinstance(c, (SendMessage, EditMessageText)) and c.chat_id == chat_id:
                out.append(c.text)
            elif isinstance(c, SendPhoto) and c.chat_id == chat_id:
                out.append(c.caption or "")
        return out

    def photos_to(self, chat_id):
        return [c for c in self.calls if isinstance(c, SendPhoto) and c.chat_id == chat_id]

    def last_markup(self, chat_id):
        for c in reversed(self.calls):
            if isinstance(c, (SendMessage, EditMessageText)) and c.chat_id == chat_id and c.reply_markup:
                return c.reply_markup
        return None

    def copies_to(self, chat_id):
        return [c for c in self.calls if isinstance(c, CopyMessage) and c.chat_id == chat_id]


class Harness:
    def __init__(self, dp, bot, session, db):
        self.dp, self.bot, self.session, self.db = dp, bot, session, db
        self.update_ids = itertools.count(1)
        self.msg_ids = itertools.count(1)

    def user(self, uid):
        return User(id=uid, is_bot=False, first_name=NAMES[uid], username=f"user{uid}")

    async def send(self, uid, text):
        msg = Message(message_id=next(self.msg_ids), date=datetime.now(),
                      chat=Chat(id=uid, type="private"), from_user=self.user(uid), text=text)
        await self.dp.feed_update(self.bot, Update(update_id=next(self.update_ids), message=msg))
        return msg

    async def press(self, uid, data):
        if not isinstance(data, str):
            data = data.pack()
        msg = Message(message_id=next(self.msg_ids), date=datetime.now(),
                      chat=Chat(id=uid, type="private"), from_user=self.user(999), text="…")
        cb = CallbackQuery(id=f"cb{next(self.update_ids)}", from_user=self.user(uid),
                           chat_instance="x", message=msg, data=data)
        await self.dp.feed_update(self.bot, Update(update_id=next(self.update_ids), callback_query=cb))

    def buttons(self, uid):
        markup = self.session.last_markup(uid)
        return [b.callback_data for row in getattr(markup, "inline_keyboard", []) for b in row]


@pytest.fixture
async def h(tmp_path):
    db = Database(str(tmp_path / "flow.db"))
    session = FakeSession()
    config = Config(bot_token="42:TEST", company="NF Group", draw_animation_delay=0)
    bot = create_bot(config, session=session)
    dp = create_dispatcher(config, db, "nf_santa_bot")
    await db.connect()
    yield Harness(dp, bot, session, db)
    await db.close()


async def join(h, uid, code, wishlist=None):
    await h.send(uid, f"/start join_{code}")
    assert "Приглашение в Тайного Санту" in h.session.texts_to(uid)[-1]
    assert h.session.photos_to(uid), "приглашение должно быть фирменной карточкой"
    game = await h.db.get_game_by_code(code)
    await h.press(uid, G(action="join", game_id=game.id))
    await h.send(uid, NAMES[uid])
    if wishlist:
        await h.send(uid, wishlist)
    else:
        await h.press(uid, G(action="wish_skip", game_id=game.id))
    assert await h.db.get_participant(game.id, uid)


async def create_game(h):
    s = h.session
    await h.send(ORG, "/new")
    await h.send(ORG, "Санта NF Group 2026")
    await h.send(ORG, "до 3000 ₽")
    await h.send(ORG, "32.12")  # такой даты нет
    assert "Не получилось разобрать дату" in s.texts_to(ORG)[-1]
    await h.send(ORG, "26.12 18:00")
    await h.press(ORG, Menu(action="skip_place"))  # место пропускаем
    await h.send(ORG, "27.12")  # жеребьёвка позже вручения — нельзя
    assert "раньше вручения" in s.texts_to(ORG)[-1]
    await h.press(ORG, Menu(action="manual_draw"))
    [game] = await h.db.list_user_games(ORG)
    assert game.exchange_at.day == 26 and game.exchange_at.hour == 18 and game.draw_at is None
    return game


async def test_full_game(h):
    s = h.session
    # --- организатор открывает лот ---
    await h.send(ORG, "/start")
    assert "ТАЙНЫЙ САНТА · NF GROUP" in s.texts_to(ORG)[0]
    assert len(s.photos_to(ORG)) == 1
    await h.send(ORG, "/start")  # вторая приветственная картинка — по кэшированному file_id
    assert isinstance(s.photos_to(ORG)[-1].photo, str)

    game = await create_game(h)
    assert any(f"t.me/nf_santa_bot?start=join_{game.code}" in t for t in s.texts_to(ORG))

    # --- коллеги присоединяются ---
    await join(h, ANYA, game.code, "Книги, настолки. Не дарить <свечи> & сладкое")
    await join(h, BORYA, game.code, "Кофе. И пентхаус на Патриарших")
    assert "департамент элитной недвижимости" in "\n".join(s.texts_to(BORYA))
    await join(h, VERA, game.code)  # без вишлиста
    assert any("Аня" in t and "заезжает" in t for t in s.texts_to(ORG))

    # напоминание про ТЗ от организатора — только Вере
    await h.press(ORG, G(action="nudge", game_id=game.id))
    assert "ТЗ для Санты пустует" in s.texts_to(VERA)[-1]
    assert "пустует" not in s.texts_to(ANYA)[-1]

    # организатор тоже участвует
    await h.press(ORG, G(action="join", game_id=game.id))
    await h.send(ORG, NAMES[ORG])
    await h.send(ORG, "Носки с оленями")

    # Глеб присоединяется и выходит
    await join(h, GLEB, game.code, "Что угодно")
    await h.press(GLEB, G(action="leave_ok", game_id=game.id))
    assert await h.db.get_participant(game.id, GLEB) is None

    # чужой не может управлять игрой
    await h.press(ANYA, G(action="draw_ok", game_id=game.id))
    assert (await h.db.get_game(game.id)).is_open

    # организатор меняет место
    await h.press(ORG, G(action="edit_f", game_id=game.id, arg=4))
    await h.send(ORG, "Переговорная «Москва-Сити»")
    assert (await h.db.get_game(game.id)).place == "Переговорная «Москва-Сити»"

    # --- исключение: Аня и Боря не дарят друг другу ---
    anya = await h.db.get_participant(game.id, ANYA)
    borya = await h.db.get_participant(game.id, BORYA)
    await h.press(ORG, G(action="excl_a", game_id=game.id))
    await h.press(ORG, G(action="excl_b", game_id=game.id, arg=anya.id))
    await h.press(ORG, G(action="excl_add", game_id=game.id, arg=anya.id, arg2=borya.id))
    assert len(await h.db.list_exclusions(game.id)) == 1

    # --- жеребьёвка ---
    await h.press(ORG, G(action="draw", game_id=game.id))
    assert "Без ТЗ: Вера" in s.texts_to(ORG)[-1]
    await h.press(ORG, G(action="draw_ok", game_id=game.id))
    assert (await h.db.get_game(game.id)).is_drawn
    report = s.texts_to(ORG)[-1]
    assert "Реестре Северного полюса".lower() in report.lower() and "Результат получили 4" in report

    people = {p.user_id: p for p in await h.db.list_participants(game.id)}
    recipients = {}
    for uid, p in people.items():
        r = await h.db.get_recipient(game.id, p.id)
        recipients[uid] = r.user_id
        assert r.user_id != uid
        caption = next(t for t in s.texts_to(uid) if "Сделка закрыта" in t)
        assert r.name in caption
    assert frozenset((ANYA, BORYA)) not in {frozenset(x) for x in recipients.items()}
    assert sorted(recipients.values()) == sorted(people)
    santa_of = {r: u for u, r in recipients.items()}
    # HTML из вишлиста экранирован
    assert "&lt;свечи&gt; &amp;" in "\n".join(s.texts_to(santa_of[ANYA]))

    # после жеребьёвки присоединиться нельзя
    await h.send(GLEB, f"/start join_{game.code}")
    assert "жеребьёвка прошла" in s.texts_to(GLEB)[-1]

    # --- анонимная переписка ---
    target = recipients[ANYA]
    await h.press(ANYA, G(action="msg_r", game_id=game.id))
    sent = await h.send(ANYA, "Какой у тебя размер?")
    assert "Ваш Тайный Санта" in s.texts_to(target)[-1]
    copy = s.copies_to(target)[-1]
    assert copy.from_chat_id == ANYA and copy.message_id == sent.message_id
    assert "Аня" not in s.texts_to(target)[-1]  # анонимно

    await h.press(target, G(action="msg_s", game_id=game.id))
    await h.send(target, "M, спасибо!")
    assert "Ваш подопечный" in s.texts_to(ANYA)[-1]
    assert s.copies_to(ANYA)[-1].from_chat_id == target

    # --- подарок готов: подопечный получает инсайд ---
    await h.press(ANYA, G(action="ready", game_id=game.id, arg=1))
    assert "подарок готов" in s.texts_to(target)[-1]
    assert (await h.db.get_participant(game.id, ANYA)).gift_ready

    # --- Вера дописывает ТЗ — её Санта получает уведомление ---
    await h.press(VERA, G(action="wish", game_id=game.id))
    await h.send(VERA, "Растение в горшке")
    assert any("обновил ТЗ" in t and "Растение" in t for t in s.texts_to(santa_of[VERA]))

    # --- идея подарка и обзор рынка ---
    await h.press(BORYA, G(action="idea", game_id=game.id))
    assert "Идея подарка" in s.texts_to(BORYA)[-1]
    await h.press(BORYA, G(action="report", game_id=game.id))
    assert "NF Research" in s.texts_to(BORYA)[-1] and "Индекс готовности" in s.texts_to(BORYA)[-1]
    assert "Номинации" not in s.texts_to(BORYA)[-1]  # до раскрытия — никаких подсказок

    # --- угадай Санту: Аня угадывает, Боря ошибается ---
    by_uid = {u: p.id for u, p in people.items()}
    await h.press(ANYA, G(action="guess", game_id=game.id))
    await h.press(ANYA, G(action="guess_set", game_id=game.id, arg=by_uid[santa_of[ANYA]]))
    wrong = next(u for u in people if u not in (BORYA, santa_of[BORYA]))
    await h.press(BORYA, G(action="guess_set", game_id=game.id, arg=by_uid[wrong]))

    # --- рассылка организатора ---
    await h.press(ORG, G(action="bcast", game_id=game.id))
    await h.send(ORG, "Не забудьте подарки!")
    for uid in (ANYA, BORYA, VERA):
        assert s.copies_to(uid)[-1].from_chat_id == ORG

    # --- раскрытие карт ---
    await h.press(ORG, G(action="reveal", game_id=game.id))
    await h.press(ORG, G(action="reveal_ok", game_id=game.id))
    assert (await h.db.get_game(game.id)).is_revealed
    anya_texts = "\n".join(s.texts_to(ANYA))
    assert "Карты раскрыты" in anya_texts and "Вы угадали" in anya_texts
    assert NAMES[santa_of[ANYA]] in anya_texts
    assert "Конспирация" in "\n".join(s.texts_to(BORYA))
    final = s.texts_to(VERA)[-1]
    assert "Номинации года" in final and "Аналитики года" in final and "Аня" in final

    # после раскрытия — «спасибо Санте» уже не анонимно
    await h.press(BORYA, G(action="msg_s", game_id=game.id))
    await h.send(BORYA, "Спасибо за кофе!")
    assert "Боря" in s.texts_to(santa_of[BORYA])[-1]

    # --- удаление игры ---
    await h.press(ORG, G(action="delete_ok", game_id=game.id))
    assert await h.db.get_game(game.id) is None
    assert "удалил игру" in s.texts_to(BORYA)[-1]

    # ни один callback не отвечен дважды
    assert all(v == 1 for v in s.answered.values()), s.answered


async def test_easter_eggs(h):
    s = h.session
    await h.send(ANYA, "Хо-хо-хо!")
    assert "Брокерская лицензия" in s.texts_to(ANYA)[-1] or "Сделка века" in s.texts_to(ANYA)[-1]
    await h.send(ANYA, "/due_diligence")
    assert "due diligence" in s.texts_to(ANYA)[-1]
    await h.send(ANYA, "/cap_rate")
    assert "капитализации" in s.texts_to(ANYA)[-1]
    await h.send(ANYA, "🎅")
    assert "Факт" in s.texts_to(ANYA)[-1]
    await h.send(ANYA, "а где тут ипотека?")
    assert "Ипотеку" in s.texts_to(ANYA)[-1]
    await h.send(ANYA, "/idea")
    assert "Идея подарка" in s.texts_to(ANYA)[-1]


async def test_restricted_creation(tmp_path):
    db = Database(str(tmp_path / "r.db"))
    session = FakeSession()
    config = Config(bot_token="42:TEST", admin_ids={ORG}, draw_animation_delay=0)
    h = Harness(create_dispatcher(config, db, "nf_santa_bot"), create_bot(config, session=session), session, db)
    await db.connect()
    try:
        await h.send(ANYA, "/new")
        assert "только организаторы" in session.texts_to(ANYA)[-1]
        await h.send(ORG, "/new")
        assert "Новый лот" in session.texts_to(ORG)[-1]
    finally:
        await db.close()


async def test_bad_link_and_fallback(h):
    await h.send(ANYA, "/start join_nope")
    assert "не найден" in h.session.texts_to(ANYA)[-1]
    await h.send(ANYA, "привет")
    assert "Я не понял" in h.session.texts_to(ANYA)[-1]
    await h.press(ANYA, "garbage")
    assert h.session.answered
