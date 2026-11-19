"""Анонимная переписка Санты и подопечного через бота."""

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramAPIError
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, Message

from .. import keyboards as kb
from .. import texts
from ..callbacks import G
from ..db import Database
from ..services import safe_send
from ..states import AnonChat

router = Router(name="chat")

# r — пишем подопечному, s — пишем своему Санте


@router.callback_query(G.filter(F.action.in_({"msg_r", "msg_s"})))
async def start_message(cb: CallbackQuery, callback_data: G, state: FSMContext, db: Database):
    direction = callback_data.action[-1]
    game = await db.get_game(callback_data.game_id)
    me = await db.get_participant(callback_data.game_id, cb.from_user.id)
    if not game or not me:
        return await cb.answer("Вы не участвуете в этой игре.", show_alert=True)
    if not game.is_drawn:
        return await cb.answer("Переписка откроется после жеребьёвки.", show_alert=True)

    if direction == "r":
        other = await db.get_recipient(game.id, me.id)
        prompt = (f"💌 Напишите сообщение подопечному — {texts.mention(other)}.\n"
                  "Отправитель останется в секрете. Можно текст, фото, стикер или голосовое.")
    else:
        other = await db.get_santa(game.id, me.id)
        prompt = ("🎅 Напишите сообщение своему Тайному Санте. Кто он — пока коммерческая тайна, "
                  "но сообщение дойдёт. Например, подсказка про размер или любимый цвет.")
        if game.is_revealed:
            prompt = f"🙏 Напишите пару тёплых слов своему Санте — {texts.mention(other)}."
    if not other:
        return await cb.answer("Собеседник не найден.", show_alert=True)

    await state.set_state(AnonChat.message)
    await state.update_data(game_id=game.id, direction=direction)
    await cb.message.answer(prompt + "\n\n/cancel — отмена", reply_markup=kb.cancel_button(game.id))
    await cb.answer()


@router.message(AnonChat.message)
async def relay(message: Message, state: FSMContext, db: Database, bot: Bot):
    data = await state.get_data()
    await state.clear()
    game = await db.get_game(data["game_id"])
    me = await db.get_participant(data["game_id"], message.from_user.id) if game else None
    if not game or not me:
        return await message.answer("Игра не найдена.")

    if data["direction"] == "r":
        target = await db.get_recipient(game.id, me.id)
        header = (f"🎅 <b>{texts.e(me.name)}</b>, ваш Санта, пишет (игра «{texts.e(game.title)}»):" if game.is_revealed
                  else f"🎅 <b>Ваш Тайный Санта</b> пишет (игра «{texts.e(game.title)}»):")
        reply_dir = "s"  # получатель отвечает своему Санте
    else:
        target = await db.get_santa(game.id, me.id)
        header = f"🎁 <b>Ваш подопечный {texts.e(me.name)}</b> пишет (игра «{texts.e(game.title)}»):"
        reply_dir = "r"  # Санта отвечает подопечному
    if not target:
        return await message.answer("Собеседник не найден.")

    if not await safe_send(bot, target.user_id, header):
        return await message.answer("😕 Не получилось доставить: похоже, собеседник остановил бота.")
    try:
        await bot.copy_message(target.user_id, message.chat.id, message.message_id,
                               reply_markup=kb.reply_to(game, reply_dir))
    except TelegramAPIError:
        return await message.answer("😕 Такой тип сообщения переслать не получилось. Попробуйте текстом.")
    await db.count_message(me.id)
    await message.answer("✅ Отправлено." if game.is_revealed else "✅ Отправлено анонимно.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
        kb.btn("✉️ Написать ещё", G(action=f"msg_{data['direction']}", game_id=game.id)),
        kb.btn("🎄 К игре", G(action="open", game_id=game.id)),
    ]]))
