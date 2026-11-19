from aiogram import Bot, F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message, ReplyKeyboardRemove

from .. import cards, humor
from .. import keyboards as kb
from .. import texts
from ..callbacks import G
from ..config import Config
from ..db import Database, Game
from ..services import build_report, quarter, render_game, safe_send, send_assignment, send_card, show
from ..states import EditProfile, Join

router = Router(name="participant")


def _clean(text: str | None) -> str:
    return (text or "").strip()


async def _luxury_egg(message: Message, game: Game | None, wish: str):
    """Пасхалка: в ТЗ просят недвижимость — передаём запрос «в профильный департамент»."""
    if game and humor.LUXURY_WISH.search(wish.lower()):
        await message.answer("💼 Запрос передан в департамент элитной недвижимости NF Group. "
                             f"Ответ ожидайте после согласования бюджета ({texts.e(game.budget)}) 😉")


# ---------- вступление в игру ----------

@router.callback_query(G.filter(F.action == "join"))
async def join(cb: CallbackQuery, callback_data: G, state: FSMContext, db: Database):
    game = await db.get_game(callback_data.game_id)
    if not game:
        return await cb.answer("Игра не найдена.", show_alert=True)
    if not game.is_open:
        return await cb.answer("Жеребьёвка уже прошла — присоединиться нельзя.", show_alert=True)
    if await db.get_participant(game.id, cb.from_user.id):
        return await cb.answer("Вы уже участвуете 🙂", show_alert=True)

    await state.set_state(Join.name)
    await state.update_data(game_id=game.id)
    await cb.message.answer(
        "Как вас представить коллегам? Напишите имя и фамилию — "
        "так ваш Санта поймёт, кому дарить подарок.\n\nМожно нажать кнопку ниже 👇",
        reply_markup=kb.name_suggestion(cb.from_user.full_name),
    )
    await cb.answer()


@router.message(Join.name)
async def join_name(message: Message, state: FSMContext, db: Database, bot: Bot):
    name = _clean(message.text)
    if not (2 <= len(name) <= texts.MAX_NAME):
        return await message.answer(f"Имя должно быть от 2 до {texts.MAX_NAME} символов. Попробуйте ещё раз.")
    data = await state.get_data()
    game = await db.get_game(data["game_id"])
    if not game or not game.is_open:
        await state.clear()
        return await message.answer("Увы, набор в эту игру уже закрыт.", reply_markup=ReplyKeyboardRemove())

    me = await db.add_participant(game.id, message.from_user.id, name, message.from_user.username)
    await state.set_state(Join.wishlist)
    await state.update_data(participant_id=me.id)
    await message.answer(f"Отлично, {texts.e(name)}! Договор аренды праздника подписан 🎉",
                         reply_markup=ReplyKeyboardRemove())
    await message.answer(
        "📝 Теперь техническое задание для Санты — ваш вишлист: что хотели бы получить, "
        "а что дарить точно не стоит. Можно ссылками.\n\n"
        "ТЗ увидит только ваш Тайный Санта. Изменить можно в любой момент.",
        reply_markup=kb.skip_button(game.id),
    )

    count = len(await db.list_participants(game.id))
    if count == 13:
        await message.answer("🍀 Вы — резидент № 13. Аналитики подтверждают: в этом лоте это к удаче!")
    if game.organizer_id != message.from_user.id:
        await safe_send(bot, game.organizer_id,
                        f"👋 <b>{texts.e(name)}</b> заезжает в лот «{texts.e(game.title)}». Резидентов: {count}.")
    if count in humor.MILESTONES:
        await safe_send(bot, game.organizer_id, humor.MILESTONES[count])


async def _finish_join(message: Message, state: FSMContext, db: Database, user_id: int, config: Config):
    data = await state.get_data()
    await state.clear()
    game = await db.get_game(data["game_id"])
    if game:
        text, markup = await render_game(db, game, user_id, config.now())
        await message.answer(text, reply_markup=markup)


@router.message(Join.wishlist)
async def join_wishlist(message: Message, state: FSMContext, db: Database, config: Config):
    wish = _clean(message.text)
    if not wish:
        return await message.answer("Пришлите вишлист текстом или нажмите «Пропустить».")
    if len(wish) > texts.MAX_WISHLIST:
        return await message.answer(f"Слишком длинно — уложитесь в {texts.MAX_WISHLIST} символов.")
    data = await state.get_data()
    await db.update_participant(data["participant_id"], wishlist=wish)
    await message.answer("📝 ТЗ сохранено!")
    await _luxury_egg(message, await db.get_game(data["game_id"]), wish)
    await _finish_join(message, state, db, message.from_user.id, config)


@router.callback_query(G.filter(F.action == "wish_skip"))
async def wish_skip(cb: CallbackQuery, state: FSMContext, db: Database, config: Config):
    if await state.get_state() != Join.wishlist.state:
        return await cb.answer()
    await cb.message.edit_reply_markup(reply_markup=None)
    await cb.message.answer("Хорошо, ТЗ можно заполнить позже через «✏️ ТЗ (вишлист)».")
    await _finish_join(cb.message, state, db, cb.from_user.id, config)
    await cb.answer()


# ---------- редактирование профиля ----------

@router.callback_query(G.filter(F.action.in_({"wish", "name"})))
async def edit_profile(cb: CallbackQuery, callback_data: G, state: FSMContext, db: Database):
    me = await db.get_participant(callback_data.game_id, cb.from_user.id)
    if not me:
        return await cb.answer("Вы не участвуете в этой игре.", show_alert=True)
    await state.update_data(game_id=me.game_id, participant_id=me.id)
    if callback_data.action == "wish":
        await state.set_state(EditProfile.wishlist)
        current = f"Сейчас:\n{texts.wishlist_block(me)}\n\n" if me.wishlist else ""
        await show(cb, f"{current}Пришлите новое ТЗ (вишлист) одним сообщением.", kb.cancel_button(me.game_id))
    else:
        await state.set_state(EditProfile.name)
        await show(cb, f"Сейчас вас зовут <b>{texts.e(me.name)}</b>. Пришлите новое имя.",
                   kb.cancel_button(me.game_id))
    await cb.answer()


@router.message(EditProfile.name)
async def edit_name(message: Message, state: FSMContext, db: Database, config: Config):
    name = _clean(message.text)
    if not (2 <= len(name) <= texts.MAX_NAME):
        return await message.answer(f"Имя должно быть от 2 до {texts.MAX_NAME} символов.")
    data = await state.get_data()
    await db.update_participant(data["participant_id"], name=name)
    await message.answer("✅ Имя обновлено.")
    await _finish_join(message, state, db, message.from_user.id, config)


@router.message(EditProfile.wishlist)
async def edit_wishlist(message: Message, state: FSMContext, db: Database, bot: Bot, config: Config):
    wish = _clean(message.text)
    if not wish:
        return await message.answer("Пришлите вишлист текстом.")
    if len(wish) > texts.MAX_WISHLIST:
        return await message.answer(f"Слишком длинно — уложитесь в {texts.MAX_WISHLIST} символов.")
    data = await state.get_data()
    await db.update_participant(data["participant_id"], wishlist=wish)
    await message.answer("📝 ТЗ сохранено!")

    game = await db.get_game(data["game_id"])
    await _luxury_egg(message, game, wish)
    if game and game.is_drawn:
        santa = await db.get_santa(game.id, data["participant_id"])
        if santa:
            me = await db.get_participant_by_id(data["participant_id"])
            await safe_send(bot, santa.user_id,
                            f"🔔 Ваш подопечный {texts.mention(me)} обновил ТЗ "
                            f"(игра «{texts.e(game.title)}»):\n{texts.wishlist_block(me)}",
                            kb.reply_to(game, "r"))
    await _finish_join(message, state, db, message.from_user.id, config)


# ---------- подопечный ----------

@router.callback_query(G.filter(F.action == "target"))
async def my_target(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot):
    game = await db.get_game(callback_data.game_id)
    me = await db.get_participant(callback_data.game_id, cb.from_user.id)
    if not game or not me:
        return await cb.answer("Вы не участвуете в этой игре.", show_alert=True)
    recipient = await db.get_recipient(game.id, me.id)
    if not recipient:
        return await cb.answer("Жеребьёвка ещё не проведена.", show_alert=True)
    await cb.answer()
    await send_assignment(bot, game, me, recipient)


# ---------- выход из игры ----------

@router.callback_query(G.filter(F.action == "leave"))
async def leave(cb: CallbackQuery, callback_data: G, db: Database):
    gid = callback_data.game_id
    await show(cb, "Точно выйти из игры? Вишлист будет удалён.",
               kb.confirm(G(action="leave_ok", game_id=gid), G(action="open", game_id=gid), "🚪 Выйти"))
    await cb.answer()


@router.callback_query(G.filter(F.action == "leave_ok"))
async def leave_ok(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot):
    game = await db.get_game(callback_data.game_id)
    me = await db.get_participant(callback_data.game_id, cb.from_user.id)
    if not game or not me:
        return await cb.answer("Вы уже не участвуете.", show_alert=True)
    if not game.is_open:
        return await cb.answer("После жеребьёвки выйти нельзя — напишите организатору.", show_alert=True)
    await db.remove_participant(me.id)
    await show(cb, f"Вы вышли из игры «{texts.e(game.title)}».")
    await safe_send(bot, game.organizer_id,
                    f"🚪 <b>{texts.e(me.name)}</b> выходит из игры «{texts.e(game.title)}».")
    await cb.answer()


# ---------- подарок готов ----------

@router.callback_query(G.filter(F.action == "ready"))
async def gift_ready(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot, config: Config):
    game = await db.get_game(callback_data.game_id)
    me = await db.get_participant(callback_data.game_id, cb.from_user.id)
    if not game or not me or not game.is_drawn:
        return await cb.answer("Сначала нужна жеребьёвка.", show_alert=True)
    ready = bool(callback_data.arg)
    if ready == me.gift_ready:
        return await cb.answer("Уже отмечено 👍")
    await db.set_gift_ready(me.id, ready)
    if ready:
        await cb.answer("🎁 Отмечено! Индекс готовности растёт", show_alert=True)
        recipient = await db.get_recipient(game.id, me.id)
        if recipient:
            await safe_send(bot, recipient.user_id,
                            f"👀 Инсайд из «{texts.e(game.title)}»: ваш Тайный Санта сообщает, что подарок готов!")
    else:
        await cb.answer("Хорошо, вернул статус «в работе»")
    game = await db.get_game(game.id)
    text, markup = await render_game(db, game, cb.from_user.id, config.now())
    await show(cb, text, markup)


# ---------- идея подарка ----------

@router.callback_query(G.filter(F.action == "idea"))
async def idea(cb: CallbackQuery, callback_data: G, db: Database):
    game = await db.get_game(callback_data.game_id)
    budget = f"\n\n<i>Бюджет лота: {texts.e(game.budget)}</i>" if game else ""
    await show(cb, f"💡 <b>Идея подарка</b>\n\n{humor.gift_idea()}{budget}", kb.idea_more(callback_data.game_id))
    await cb.answer()


# ---------- угадай Санту ----------

@router.callback_query(G.filter(F.action == "guess"))
async def guess(cb: CallbackQuery, callback_data: G, db: Database):
    game = await db.get_game(callback_data.game_id)
    me = await db.get_participant(callback_data.game_id, cb.from_user.id)
    if not game or not me:
        return await cb.answer("Вы не участвуете в этой игре.", show_alert=True)
    if not game.is_drawn:
        return await cb.answer("Угадывать можно после жеребьёвки.", show_alert=True)
    if game.is_revealed:
        return await cb.answer("Карты уже раскрыты — загляните в «🎭 Кто был моим Сантой».", show_alert=True)
    people = await db.list_participants(game.id)
    current = next((p.name for p in people if p.id == me.guess_id), None)
    note = f"\nВаш текущий прогноз: <b>{texts.e(current)}</b> (можно изменить)." if current else ""
    await show(cb, "🕵️ <b>Аналитика: кто ваш Тайный Санта?</b>\n\n"
                   "Вспомните стиль сообщений, подсказки в подарке, подозрительные взгляды у кофемашины… "
                   f"Ответ узнаете, когда организатор раскроет карты.{note}",
               kb.pick_member(game, people, "guess_set", skip=me.id, back="open", mark=me.guess_id))
    await cb.answer()


@router.callback_query(G.filter(F.action == "guess_set"))
async def guess_set(cb: CallbackQuery, callback_data: G, db: Database, config: Config):
    game = await db.get_game(callback_data.game_id)
    me = await db.get_participant(callback_data.game_id, cb.from_user.id)
    target = await db.get_participant_by_id(callback_data.arg)
    if not game or not me or not target or target.game_id != game.id or target.id == me.id:
        return await cb.answer("Не получилось.", show_alert=True)
    if game.is_revealed:
        return await cb.answer("Карты уже раскрыты.", show_alert=True)
    await db.set_guess(me.id, target.id)
    await cb.answer(f"Прогноз принят: {target.name}. Посмотрим, подтвердит ли рынок 📈", show_alert=True)
    text, markup = await render_game(db, game, cb.from_user.id, config.now())
    await show(cb, text, markup)


@router.callback_query(G.filter(F.action == "whois"))
async def whois(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot):
    game = await db.get_game(callback_data.game_id)
    me = await db.get_participant(callback_data.game_id, cb.from_user.id)
    if not game or not me or not game.is_revealed:
        return await cb.answer("Карты ещё не раскрыты 🤫", show_alert=True)
    santa = await db.get_santa(game.id, me.id)
    if not santa:
        return await cb.answer("Санта не найден.", show_alert=True)
    await cb.answer()
    guessed = None if not me.guess_id else me.guess_id == santa.id
    await send_card(bot, cb.from_user.id, cards.reveal_card, santa.name, guessed, game.title,
                    caption=f"🎭 Вашим Тайным Сантой был(а) {texts.mention(santa)}.",
                    reply_markup=kb.back_to_game(game.id))


# ---------- обзор рынка подарков ----------

@router.callback_query(G.filter(F.action == "report"))
async def report(cb: CallbackQuery, callback_data: G, db: Database, bot: Bot, config: Config):
    game = await db.get_game(callback_data.game_id)
    if not game:
        return await cb.answer("Игра не найдена.", show_alert=True)
    if game.organizer_id != cb.from_user.id and not await db.get_participant(game.id, cb.from_user.id):
        return await cb.answer("Вы не участвуете в этой игре.", show_alert=True)
    await cb.answer("Готовим отчёт NF Research…")
    now = config.now()
    kpis, text = await build_report(db, game, now)
    await send_card(bot, cb.from_user.id, cards.research_card, game.title, kpis, quarter(now))
    await safe_send(bot, cb.from_user.id, text, kb.back_to_game(game.id))
