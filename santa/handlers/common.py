from aiogram import Bot, F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message, ReplyKeyboardRemove

from .. import cards, humor
from .. import keyboards as kb
from .. import texts
from ..callbacks import G, Menu
from ..config import Config
from ..db import Database
from ..services import render_game, send_card, send_invite, show

router = Router(name="common")


@router.message(CommandStart(deep_link=True))
async def start_with_link(message: Message, command: CommandObject, state: FSMContext, db: Database,
                          config: Config, bot: Bot, bot_username: str):
    await state.clear()
    arg = command.args or ""
    if not arg.startswith("join_"):
        return await start(message, state, config, bot)
    game = await db.get_game_by_code(arg.removeprefix("join_"))
    if not game:
        return await message.answer("😕 Лот по этой ссылке не найден. Попросите организатора прислать новую ссылку.")

    me = await db.get_participant(game.id, message.from_user.id)
    if me or game.organizer_id == message.from_user.id:
        text, markup = await render_game(db, game, message.from_user.id, config.now())
        return await message.answer(text, reply_markup=markup)
    if not game.is_open:
        return await message.answer(
            f"⏰ В игре «{texts.e(game.title)}» сделки уже закрыты — жеребьёвка прошла. Напишите организатору."
        )
    await send_invite(bot, message.chat.id, db, game, bot_username, with_join_button=True)


@router.message(CommandStart())
@router.message(Command("menu"))
async def start(message: Message, state: FSMContext, config: Config, bot: Bot):
    await state.clear()
    year = config.now().year
    await send_card(bot, message.chat.id, cards.welcome_card, year,
                    caption=texts.welcome(config.company), cache_key=f"welcome:{year}")
    await message.answer("Что делаем?", reply_markup=kb.main_menu(config.can_create_games(message.from_user.id)))


@router.message(Command("help"))
async def help_cmd(message: Message):
    await message.answer(texts.HELP)


@router.message(Command("cancel"))
async def cancel(message: Message, state: FSMContext, config: Config):
    had_state = await state.get_state() is not None
    await state.clear()
    await message.answer("Отменено." if had_state else "Нечего отменять.", reply_markup=ReplyKeyboardRemove())
    await message.answer("Главное меню:", reply_markup=kb.main_menu(config.can_create_games(message.from_user.id)))


async def _games_view(user_id: int, db: Database, config: Config):
    games = await db.list_user_games(user_id)
    can_create = config.can_create_games(user_id)
    if not games:
        text = "У вас пока нет игр. Попросите у организатора ссылку-приглашение"
        text += " или откройте свой лот." if can_create else "."
    else:
        text = ("🎁 <b>Ваш портфель</b>\n"
                "🎲 — идёт набор, 🤝 — сделки закрыты, 🎭 — карты раскрыты, 👑 — вы организатор")
    return text, kb.games_list(games, user_id, can_create)


@router.message(Command("games"))
async def games_cmd(message: Message, state: FSMContext, db: Database, config: Config):
    await state.clear()
    text, markup = await _games_view(message.from_user.id, db, config)
    await message.answer(text, reply_markup=markup)


@router.callback_query(Menu.filter(F.action == "games"))
async def games_cb(cb: CallbackQuery, state: FSMContext, db: Database, config: Config):
    await state.clear()
    text, markup = await _games_view(cb.from_user.id, db, config)
    await show(cb, text, markup)
    await cb.answer()


@router.callback_query(Menu.filter(F.action == "home"))
async def home_cb(cb: CallbackQuery, state: FSMContext, config: Config):
    await state.clear()
    await show(cb, "Что делаем?", kb.main_menu(config.can_create_games(cb.from_user.id)))
    await cb.answer()


@router.message(Command("idea"))
async def idea_cmd(message: Message):
    await message.answer(f"💡 <b>Идея подарка</b>\n\n{humor.gift_idea()}", reply_markup=kb.idea_more())


@router.callback_query(Menu.filter(F.action == "idea"))
async def idea_menu(cb: CallbackQuery):
    await show(cb, f"💡 <b>Идея подарка</b>\n\n{humor.gift_idea()}", kb.idea_more())
    await cb.answer()


@router.callback_query(G.filter(F.action == "open"))
async def open_game(cb: CallbackQuery, callback_data: G, state: FSMContext, db: Database, config: Config):
    await state.clear()
    game = await db.get_game(callback_data.game_id)
    if not game:
        return await cb.answer("Игра удалена.", show_alert=True)
    is_member = await db.get_participant(game.id, cb.from_user.id)
    if not is_member and game.organizer_id != cb.from_user.id:
        return await cb.answer("Вы не участвуете в этой игре.", show_alert=True)
    text, markup = await render_game(db, game, cb.from_user.id, config.now())
    await show(cb, text, markup)
    await cb.answer()


# ---------- секретные команды (в меню их нет) ----------

@router.message(Command("due_diligence", "dd"))
async def due_diligence(message: Message):
    await message.answer(humor.DUE_DILIGENCE)


@router.message(Command("cap_rate", "caprate"))
async def cap_rate(message: Message):
    await message.answer(humor.CAP_RATE)


@router.message(Command("ho", "hohoho"))
async def hohoho(message: Message):
    await message.answer(humor.easter_egg("хо-хо-хо"))
