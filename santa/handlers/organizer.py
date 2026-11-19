import asyncio
from datetime import datetime, time, timedelta

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message

from .. import dates, humor
from .. import keyboards as kb
from .. import texts
from ..callbacks import G, Menu
from ..config import Config
from ..db import Database, Game
from ..draw import MIN_PARTICIPANTS, DrawError
from ..scheduler import DRAW_KINDS, EXCHANGE_KINDS
from ..services import nudge_wishlists, render_admin, reveal_game, run_draw, safe_send, send_invite, show
from ..states import Broadcast, CreateGame, EditGame

router = Router(name="organizer")

EDIT_FIELDS = {
    1: ("title", "название"),
    2: ("budget", "бюджет"),
    3: ("exchange_at", "дату сделки"),
    4: ("place", "место вручения"),
    5: ("draw_at", "дату жеребьёвки"),
}

DATE_HELP = ("Например: <code>26.12 18:00</code>, <code>26 декабря</code>, <code>26.12.2026</code> "
             "или <code>завтра 19:00</code>.")


def parse_future(text: str, now: datetime, default_time: time | None = None) -> datetime:
    dt = dates.parse_when(text, now)
    if default_time and not dates.has_time(dt):
        dt = datetime.combine(dt.date(), default_time)
    end_of_day = dt if dates.has_time(dt) else datetime.combine(dt.date(), time(23, 59))
    if end_of_day <= now:
        raise dates.DateError("эта дата уже прошла")
    if dt > now + timedelta(days=400):
        raise dates.DateError("слишком далеко — Санта так далеко не планирует")
    return dt


# ---------- создание игры ----------

async def _start_creation(user_id: int, answer, state: FSMContext, config: Config):
    if not config.can_create_games(user_id):
        return await answer("Открывать лоты могут только организаторы. Попросите у них ссылку-приглашение.")
    await state.clear()
    await state.set_state(CreateGame.title)
    await answer(
        "🏢 <b>Новый лот</b>\n\nШаг 1 из 5. Как назовём игру? Например: <i>Тайный Санта NF Group 2026</i> "
        "или <i>Новый год — департамент офисной недвижимости</i>.\n\n/cancel — отмена"
    )


@router.message(Command("new"))
async def new_cmd(message: Message, state: FSMContext, config: Config):
    await _start_creation(message.from_user.id, message.answer, state, config)


@router.callback_query(Menu.filter(F.action == "new"))
async def new_cb(cb: CallbackQuery, state: FSMContext, config: Config):
    await _start_creation(cb.from_user.id, cb.message.answer, state, config)
    await cb.answer()


@router.message(CreateGame.title)
async def create_title(message: Message, state: FSMContext):
    title = (message.text or "").strip()
    if not (2 <= len(title) <= texts.MAX_TITLE):
        return await message.answer(f"Название — от 2 до {texts.MAX_TITLE} символов.")
    await state.update_data(title=title)
    await state.set_state(CreateGame.budget)
    await message.answer("💰 Шаг 2 из 5. Бюджет подарка? Например: <i>до 3000 ₽</i> или <i>2000–3000 ₽</i>.")


@router.message(CreateGame.budget)
async def create_budget(message: Message, state: FSMContext):
    budget = (message.text or "").strip()
    if not (1 <= len(budget) <= texts.MAX_FIELD):
        return await message.answer(f"Напишите бюджет текстом (до {texts.MAX_FIELD} символов).")
    await state.update_data(budget=budget)
    await state.set_state(CreateGame.date)
    await message.answer(f"📅 Шаг 3 из 5. Когда вручаем подарки? {DATE_HELP}\n\n"
                         "По этой дате бот будет напоминать Сантам о подарках.")


@router.message(CreateGame.date)
async def create_date(message: Message, state: FSMContext, config: Config):
    try:
        when = parse_future(message.text or "", config.now())
    except dates.DateError as exc:
        return await message.answer(f"Не получилось разобрать дату: {exc}. {DATE_HELP}")
    await state.update_data(exchange_at=dates.to_db(when))
    await state.set_state(CreateGame.place)
    await message.answer(f"Записал: <b>{dates.fmt(when)}</b>.\n\n📍 Шаг 4 из 5. Где вручаем? "
                         "Например: <i>переговорная на 5 этаже</i> или <i>корпоратив</i>.",
                         reply_markup=kb.skip_place_button())


async def _ask_draw(answer, state: FSMContext):
    await state.set_state(CreateGame.draw)
    await answer("🎲 Шаг 5 из 5. Когда провести жеребьёвку? Бот проведёт её сам в указанное время, "
                 f"а за сутки напомнит про ТЗ тем, кто его не заполнил. {DATE_HELP}",
                 reply_markup=kb.manual_draw_button())


@router.message(CreateGame.place)
async def create_place(message: Message, state: FSMContext):
    place = (message.text or "").strip()
    if not (1 <= len(place) <= texts.MAX_FIELD):
        return await message.answer(f"Напишите место текстом (до {texts.MAX_FIELD} символов) или нажмите «Пропустить».")
    await state.update_data(place=place)
    await _ask_draw(message.answer, state)


@router.callback_query(CreateGame.place, Menu.filter(F.action == "skip_place"))
async def skip_place(cb: CallbackQuery, state: FSMContext):
    await state.update_data(place="")
    await cb.message.edit_reply_markup(reply_markup=None)
    await _ask_draw(cb.message.answer, state)
    await cb.answer()


@router.message(CreateGame.draw)
async def create_draw(message: Message, state: FSMContext, db: Database, config: Config, bot: Bot, bot_username: str):
    data = await state.get_data()
    exchange_at = dates.from_db(data["exchange_at"])
    try:
        draw_at = parse_future(message.text or "", config.now(), default_time=time(12, 0))
    except dates.DateError as exc:
        return await message.answer(f"Не получилось разобрать дату: {exc}. {DATE_HELP}",
                                    reply_markup=kb.manual_draw_button())
    if draw_at >= exchange_at:
        return await message.answer("Жеребьёвка должна быть раньше вручения подарков 🙂 Попробуйте другую дату.",
                                    reply_markup=kb.manual_draw_button())
    await _finish_creation(message.from_user.id, message.answer, state, db, config, bot, bot_username, draw_at)


@router.callback_query(CreateGame.draw, Menu.filter(F.action == "manual_draw"))
async def manual_draw(cb: CallbackQuery, state: FSMContext, db: Database, config: Config, bot: Bot,
                      bot_username: str):
    await cb.message.edit_reply_markup(reply_markup=None)
    await _finish_creation(cb.from_user.id, cb.message.answer, state, db, config, bot, bot_username, None)
    await cb.answer()


async def _finish_creation(user_id, answer, state, db, config, bot, bot_username, draw_at):
    data = await state.get_data()
    await state.clear()
    exchange_at = dates.from_db(data["exchange_at"])
    game = await db.create_game(data["title"], data["budget"], dates.fmt(exchange_at), user_id,
                                exchange_at=exchange_at, place=data.get("place", ""), draw_at=draw_at)
    await answer(f"✅ Лот № {game.id:04d} «<b>{texts.e(game.title)}</b>» открыт!\n\n"
                 "Ниже — фирменное приглашение. Перешлите его в рабочий чат 👇")
    await send_invite(bot, user_id, db, game, bot_username)
    text, markup = await render_admin(db, game, bot_username, config.now())
    await answer(text, reply_markup=markup)


# ---------- панель организатора ----------

async def _own_game(cb: CallbackQuery, db: Database, game_id: int) -> Game | None:
    game = await db.get_game(game_id)
    if not game:
        await cb.answer("Игра не найдена.", show_alert=True)
        return None
    if game.organizer_id != cb.from_user.id:
        await cb.answer("Это может сделать только организатор.", show_alert=True)
        return None
    return game


def _back(game: Game) -> InlineKeyboardMarkup:
    return kb.markup([kb.btn("⬅️ Назад", G(action="admin", game_id=game.id))])


@router.callback_query(G.filter(F.action == "admin"))
async def admin(cb: CallbackQuery, callback_data: G, state: FSMContext, db: Database, config: Config,
                bot_username: str):
    await state.clear()
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    text, markup = await render_admin(db, game, bot_username, config.now())
    await show(cb, text, markup)
    await cb.answer()


@router.callback_query(G.filter(F.action == "invite"))
async def invite(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot, bot_username: str):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    await cb.answer()
    await send_invite(bot, cb.from_user.id, db, game, bot_username)


@router.callback_query(G.filter(F.action == "nudge"))
async def nudge(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    sent = await nudge_wishlists(bot, db, game)
    await cb.answer(f"Напомнили {sent} {dates.plural(sent, ('резиденту', 'резидентам', 'резидентам'))}"
                    if sent else "Все уже заполнили ТЗ 👏", show_alert=True)


@router.callback_query(G.filter(F.action == "members"))
async def members(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    await _show_members(cb, game, db)
    await cb.answer()


async def _show_members(cb: CallbackQuery, game: Game, db: Database):
    people = await db.list_participants(game.id)
    if people:
        lines = [f"{i}. {'📝' if p.wishlist.strip() else '⏳'} {texts.mention(p)}" for i, p in enumerate(people, 1)]
        body = "\n".join(lines) + "\n\n📝 — ТЗ заполнено, ⏳ — ещё нет"
    else:
        body = "Пока никого. Отправьте коллегам приглашение."
    await show(cb, f"👥 <b>Резиденты ({len(people)})</b>\n\n{body}", kb.members_menu(game, people))


@router.callback_query(G.filter(F.action == "kick"))
async def kick(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    p = await db.get_participant_by_id(callback_data.arg)
    if not p or p.game_id != game.id:
        return await cb.answer("Участник не найден.", show_alert=True)
    await show(cb, f"Удалить {texts.mention(p)} из игры?",
               kb.confirm(G(action="kick_ok", game_id=game.id, arg=p.id), G(action="members", game_id=game.id),
                          "❌ Удалить"))
    await cb.answer()


@router.callback_query(G.filter(F.action == "kick_ok"))
async def kick_ok(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    if not game.is_open:
        return await cb.answer("После жеребьёвки удалять участников нельзя.", show_alert=True)
    p = await db.get_participant_by_id(callback_data.arg)
    if p and p.game_id == game.id:
        await db.remove_participant(p.id)
        if p.user_id != cb.from_user.id:
            await safe_send(bot, p.user_id, f"Организатор исключил вас из игры «{texts.e(game.title)}».")
    await _show_members(cb, game, db)
    await cb.answer("Удалено")


# ---------- редактирование игры ----------

@router.callback_query(G.filter(F.action == "edit"))
async def edit(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    await show(cb, "Что изменить в параметрах лота?", kb.edit_menu(game, EDIT_FIELDS))
    await cb.answer()


def _current_value(game: Game, field: str) -> str:
    value = getattr(game, field)
    if isinstance(value, datetime):
        return dates.fmt(value)
    return value or "не задано"


@router.callback_query(G.filter(F.action == "edit_f"))
async def edit_field(cb: CallbackQuery, callback_data: G, state: FSMContext, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    field, label = EDIT_FIELDS.get(callback_data.arg, EDIT_FIELDS[1])
    await state.set_state(EditGame.value)
    await state.update_data(game_id=game.id, field=field)
    hint = ""
    if field in ("exchange_at", "draw_at"):
        hint = f"\n{DATE_HELP}"
    if field in ("draw_at", "place"):
        hint += "\nОтправьте «-», чтобы убрать."
    await show(cb, f"Сейчас: <b>{texts.e(_current_value(game, field))}</b>\n\n"
                   f"Пришлите новое значение: {label}.{hint}", _back(game))
    await cb.answer()


@router.message(EditGame.value)
async def edit_value(message: Message, state: FSMContext, db: Database, config: Config, bot_username: str):
    data = await state.get_data()
    field = data["field"]
    game = await db.get_game(data["game_id"])
    if not game or game.organizer_id != message.from_user.id:
        return await state.clear()
    raw = (message.text or "").strip()
    now = config.now()
    updates: dict = {}
    try:
        if field in ("draw_at", "place") and raw == "-":
            updates[field] = None if field == "draw_at" else ""
        elif field == "exchange_at":
            dt = parse_future(raw, now)
            if game.is_open and game.draw_at and game.draw_at >= dt:
                raise dates.DateError("вручение должно быть позже жеребьёвки")
            updates = {"exchange_at": dt, "exchange_date": dates.fmt(dt)}
        elif field == "draw_at":
            dt = parse_future(raw, now, default_time=time(12, 0))
            if game.exchange_at and dt >= game.exchange_at:
                raise dates.DateError("жеребьёвка должна быть раньше вручения")
            updates["draw_at"] = dt
        else:
            limit = texts.MAX_TITLE if field == "title" else texts.MAX_FIELD
            if not (1 <= len(raw) <= limit):
                return await message.answer(f"Нужен текст длиной до {limit} символов.")
            updates[field] = raw
    except dates.DateError as exc:
        return await message.answer(f"Не получилось: {exc}. {DATE_HELP}")

    await state.clear()
    await db.update_game(game.id, **updates)
    if "exchange_at" in updates:
        await db.reset_reminders(game.id, EXCHANGE_KINDS)
    if "draw_at" in updates:
        await db.reset_reminders(game.id, DRAW_KINDS)
    game = await db.get_game(game.id)
    await message.answer("✅ Сохранено.")
    text, markup = await render_admin(db, game, bot_username, now)
    await message.answer(text, reply_markup=markup)


# ---------- исключения ----------

@router.callback_query(G.filter(F.action == "excl"))
async def exclusions(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    await _show_exclusions(cb, game, db)
    await cb.answer()


async def _show_exclusions(cb: CallbackQuery, game: Game, db: Database):
    items = await db.list_exclusions(game.id)
    text = (
        "🚫 <b>Исключения</b>\n\n"
        "Пары, которые не будут дарить подарки друг другу — например, супруги "
        "или коллеги, которые и так обменяются подарками.\n\n"
        + ("\n".join(f"• {texts.e(x.a.name)} ↔ {texts.e(x.b.name)}" for x in items) if items else "Пока нет.")
    )
    await show(cb, text, kb.exclusions_menu(game, items))


@router.callback_query(G.filter(F.action == "excl_a"))
async def exclusion_first(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    people = await db.list_participants(game.id)
    if len(people) < 2:
        return await cb.answer("Нужно хотя бы два резидента.", show_alert=True)
    await show(cb, "Выберите первого участника пары:", kb.pick_member(game, people, "excl_b"))
    await cb.answer()


@router.callback_query(G.filter(F.action == "excl_b"))
async def exclusion_second(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    first = await db.get_participant_by_id(callback_data.arg)
    if not first or first.game_id != game.id:
        return await cb.answer("Участник не найден.", show_alert=True)
    people = await db.list_participants(game.id)
    await show(cb, f"С кем <b>{texts.e(first.name)}</b> не должен обмениваться подарками?",
               kb.pick_member(game, people, "excl_add", arg=first.id, skip=first.id))
    await cb.answer()


@router.callback_query(G.filter(F.action == "excl_add"))
async def exclusion_add(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    a = await db.get_participant_by_id(callback_data.arg)
    b = await db.get_participant_by_id(callback_data.arg2)
    if not a or not b or a.game_id != game.id or b.game_id != game.id:
        return await cb.answer("Участник не найден.", show_alert=True)
    added = await db.add_exclusion(game.id, a.id, b.id)
    await _show_exclusions(cb, game, db)
    await cb.answer("Пара добавлена" if added else "Такая пара уже есть")


@router.callback_query(G.filter(F.action == "excl_del"))
async def exclusion_delete(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    await db.delete_exclusion(game.id, callback_data.arg)
    await _show_exclusions(cb, game, db)
    await cb.answer("Удалено")


# ---------- жеребьёвка ----------

@router.callback_query(G.filter(F.action == "draw"))
async def draw(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    if not game.is_open:
        return await cb.answer("Жеребьёвка уже проведена.", show_alert=True)
    people = await db.list_participants(game.id)
    if len(people) < MIN_PARTICIPANTS:
        return await cb.answer(f"Нужно минимум {MIN_PARTICIPANTS} резидента, сейчас {len(people)}.", show_alert=True)
    no_wish = [p for p in people if not p.wishlist.strip()]
    warn = ""
    if no_wish:
        warn = (f"\n\n⚠️ Без ТЗ: {', '.join(texts.e(p.name) for p in no_wish)}. "
                "Они смогут дописать его и после жеребьёвки — Санта получит уведомление.")
    await show(
        cb,
        f"🎲 Закрываем сделки среди <b>{len(people)}</b> резидентов?\n\n"
        f"После этого новые участники не смогут присоединиться, а каждый получит своего подопечного.{warn}",
        kb.confirm(G(action="draw_ok", game_id=game.id), G(action="admin", game_id=game.id), "🎲 Поехали!"),
    )
    await cb.answer()


@router.callback_query(G.filter(F.action == "draw_ok"))
async def draw_ok(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot, config: Config, bot_username: str):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    if not game.is_open:
        return await cb.answer("Жеребьёвка уже проведена.", show_alert=True)
    await cb.answer("Тасуем шапку Санты… 🎅")
    progress = []
    for stage in humor.DRAW_STAGES:  # пасхалка: жеребьёвка как настоящая сделка
        progress.append(stage)
        await show(cb, "\n".join(progress))
        await asyncio.sleep(config.draw_animation_delay)
    try:
        delivered, failed = await run_draw(bot, db, game)
    except DrawError as exc:
        return await show(cb, f"😕 {texts.e(str(exc))}", _back(game))
    if not delivered and not failed:
        return await show(cb, "Жеребьёвка уже была проведена.", _back(game))

    report = "\n".join(progress) + f"\n\n✅ <b>Сделки закрыты!</b> Результат получили {delivered} резидентов."
    if failed:
        report += ("\n\n⚠️ Не удалось написать (вероятно, остановили бота): "
                   + ", ".join(texts.mention(p) for p in failed)
                   + ".\nПопросите их открыть бота и нажать «🎯 Мой подопечный».")
    report += "\n\nКто кому дарит — знает только бот 🤫 Напоминания о подарках бот пришлёт сам."
    game = await db.get_game(game.id)
    _, markup = await render_admin(db, game, bot_username, config.now())
    await show(cb, report, markup)


# ---------- раскрытие карт ----------

@router.callback_query(G.filter(F.action == "reveal"))
async def reveal(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    if game.status != "drawn":
        return await cb.answer("Раскрыть карты можно только после жеребьёвки и один раз.", show_alert=True)
    people = await db.list_participants(game.id)
    guessed = sum(1 for p in people if p.guess_id)
    await show(cb, f"🎭 Раскрыть карты в «{texts.e(game.title)}»?\n\n"
                   f"Каждый узнает, кто был его Сантой. Прогноз сделали {guessed} из {len(people)}. "
                   "Всем придут итоги и номинации года.",
               kb.confirm(G(action="reveal_ok", game_id=game.id), G(action="admin", game_id=game.id), "🎭 Раскрыть"))
    await cb.answer()


@router.callback_query(G.filter(F.action == "reveal_ok"))
async def reveal_ok(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot, config: Config):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    await cb.answer("Раскрываем…")
    sent = await reveal_game(bot, db, game, config.now())
    await show(cb, f"🎭 Карты раскрыты! Персональные результаты получили {sent} резидентов.",
               kb.back_to_game(game.id))


# ---------- рассылка ----------

@router.callback_query(G.filter(F.action == "bcast"))
async def broadcast(cb: CallbackQuery, callback_data: G, state: FSMContext, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    await state.set_state(Broadcast.message)
    await state.update_data(game_id=game.id)
    await show(cb, "📢 Пришлите сообщение для всех резидентов — текст, фото или файл. "
                   "Например, где и во сколько вручаем подарки.", _back(game))
    await cb.answer()


@router.message(Broadcast.message)
async def broadcast_send(message: Message, state: FSMContext, db: Database, bot: Bot, config: Config,
                         bot_username: str):
    data = await state.get_data()
    await state.clear()
    game = await db.get_game(data["game_id"])
    if not game or game.organizer_id != message.from_user.id:
        return
    sent = 0
    for p in await db.list_participants(game.id):
        if p.user_id == message.from_user.id:
            continue
        if not await safe_send(bot, p.user_id, f"📢 <b>Организатор «{texts.e(game.title)}»:</b>"):
            continue
        try:
            await bot.copy_message(p.user_id, message.chat.id, message.message_id)
            sent += 1
        except TelegramAPIError:
            pass
    await message.answer(f"✅ Разослано резидентам: {sent}.")
    text, markup = await render_admin(db, game, bot_username, config.now())
    await message.answer(text, reply_markup=markup)


# ---------- удаление ----------

@router.callback_query(G.filter(F.action == "delete"))
async def delete(cb: CallbackQuery, callback_data: G, db: Database):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    await show(cb, f"Удалить игру «{texts.e(game.title)}» вместе со всеми участниками и результатами? "
                   "Это нельзя отменить.",
               kb.confirm(G(action="delete_ok", game_id=game.id), G(action="admin", game_id=game.id), "🗑 Удалить"))
    await cb.answer()


@router.callback_query(G.filter(F.action == "delete_ok"))
async def delete_ok(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot):
    if not (game := await _own_game(cb, db, callback_data.game_id)):
        return
    people = await db.list_participants(game.id)
    await db.delete_game(game.id)
    for p in people:
        if p.user_id != cb.from_user.id:
            await safe_send(bot, p.user_id, f"❌ Организатор удалил игру «{texts.e(game.title)}».")
    await show(cb, f"Игра «{texts.e(game.title)}» удалена.",
               kb.markup([kb.btn("⬅️ Мои игры", Menu(action="games"))]))
    await cb.answer()
