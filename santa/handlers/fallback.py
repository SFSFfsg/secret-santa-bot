from aiogram import F, Router
from aiogram.types import CallbackQuery, Message

from .. import humor
from .. import keyboards as kb
from ..config import Config

router = Router(name="fallback")


# ---------- всё остальное ----------

@router.message(F.text)
async def unknown_text(message: Message, config: Config):
    if egg := humor.easter_egg(message.text):
        return await message.answer(egg)
    await unknown_message(message, config)


@router.message()
async def unknown_message(message: Message, config: Config):
    await message.answer(
        "Я не понял 🙂 Откройте меню, чтобы выбрать действие.",
        reply_markup=kb.main_menu(config.can_create_games(message.from_user.id)),
    )


@router.callback_query()
async def unknown_callback(cb: CallbackQuery):
    await cb.answer("Кнопка устарела — откройте /menu.", show_alert=True)
