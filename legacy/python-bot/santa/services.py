import asyncio
import logging
from datetime import datetime

from aiogram import Bot
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest, TelegramRetryAfter
from aiogram.types import BufferedInputFile, CallbackQuery, InlineKeyboardMarkup

from . import cards, dates, humor
from . import keyboards as kb
from . import texts
from .db import Database, Game, Participant
from .draw import make_assignment

log = logging.getLogger(__name__)

# file_id уже загруженных статичных картинок — чтобы не отправлять PNG каждый раз
_file_ids: dict[str, str] = {}


async def safe_send(bot: Bot, chat_id: int, text: str, reply_markup: InlineKeyboardMarkup | None = None) -> bool:
    """Отправка, которая не падает, если человек заблокировал бота."""
    for _ in range(2):
        try:
            await bot.send_message(chat_id, text, reply_markup=reply_markup, disable_web_page_preview=True)
            return True
        except TelegramRetryAfter as exc:
            await asyncio.sleep(exc.retry_after)
        except TelegramAPIError as exc:
            log.warning("Не удалось отправить сообщение %s: %s", chat_id, exc)
            return False
    return False


async def send_card(bot: Bot, chat_id: int, render, *args, caption: str = "",
                    reply_markup: InlineKeyboardMarkup | None = None, cache_key: str | None = None) -> bool:
    """Отправляет фирменную карточку. Если картинка не ушла — хотя бы текст."""
    try:
        if cache_key and cache_key in _file_ids:
            photo = _file_ids[cache_key]
        else:
            png = await asyncio.to_thread(render, *args)
            photo = BufferedInputFile(png, filename="nf-santa.png")
        msg = await bot.send_photo(chat_id, photo, caption=caption, reply_markup=reply_markup)
        if cache_key and msg.photo:
            _file_ids[cache_key] = msg.photo[-1].file_id
        return True
    except TelegramAPIError as exc:
        log.warning("Не удалось отправить карточку %s: %s", chat_id, exc)
        return await safe_send(bot, chat_id, caption, reply_markup) if caption else False


async def show(cb: CallbackQuery, text: str, reply_markup: InlineKeyboardMarkup | None = None) -> None:
    """Редактирует сообщение с кнопками, а если нельзя (например, это картинка) — отправляет новое."""
    try:
        await cb.message.edit_text(text, reply_markup=reply_markup, disable_web_page_preview=True)
    except TelegramBadRequest as exc:
        if "message is not modified" not in str(exc):
            await cb.message.answer(text, reply_markup=reply_markup, disable_web_page_preview=True)


async def render_game(db: Database, game: Game, user_id: int, now: datetime) -> tuple[str, InlineKeyboardMarkup]:
    members = await db.list_participants(game.id)
    me = next((p for p in members if p.user_id == user_id), None)
    is_org = game.organizer_id == user_id
    return texts.game_card(game, len(members), me, is_org, now), kb.game_menu(game, me, is_org)


async def render_admin(db: Database, game: Game, bot_username: str, now: datetime) -> tuple[str, InlineKeyboardMarkup]:
    members = await db.list_participants(game.id)
    exclusions = await db.list_exclusions(game.id)
    with_wish = sum(1 for p in members if p.wishlist.strip())
    ready = sum(1 for p in members if p.gift_ready)
    org_in = any(p.user_id == game.organizer_id for p in members)
    lines = [
        "⚙️ <b>Управление лотом</b>",
        "",
        texts.game_header(game, len(members), now),
        f"📝 ТЗ заполнили: {with_wish} из {len(members)}",
    ]
    if game.is_drawn:
        lines.append(f"🎁 Индекс готовности подарков: {ready} из {len(members)}")
        guessed = sum(1 for p in members if p.guess_id)
        lines.append(f"🕵️ Сделали прогноз «кто мой Санта»: {guessed} из {len(members)}")
    else:
        lines.append(f"🚫 Исключений: {len(exclusions)}")
        lines += ["", "🔗 Ссылка-приглашение:", f"<code>{texts.invite_link(bot_username, game)}</code>"]
    return "\n".join(lines), kb.admin_menu(game, org_in)


async def send_invite(bot: Bot, chat_id: int, db: Database, game: Game, bot_username: str,
                      with_join_button: bool = False) -> None:
    count = len(await db.list_participants(game.id))
    link = None if with_join_button else texts.invite_link(bot_username, game)
    await send_card(bot, chat_id, cards.invite_card, game.title, game.budget, texts.when_short(game), count, game.id,
                    caption=texts.invite_caption(game, link),
                    reply_markup=kb.join_invite(game) if with_join_button else None)


async def send_assignment(bot: Bot, game: Game, santa: Participant, recipient: Participant) -> bool:
    contract = f"{game.id}-{santa.id:04d}"
    ok = await send_card(bot, santa.user_id, cards.assignment_card, game.title, recipient.name, game.budget,
                         texts.when_short(game), contract, caption=texts.assignment_caption(game, recipient))
    if ok:
        await safe_send(bot, santa.user_id, texts.assignment_details(game, recipient), kb.after_draw(game))
    return ok


async def run_draw(bot: Bot, db: Database, game: Game) -> tuple[int, list[Participant]]:
    """Проводит жеребьёвку и рассылает результаты.

    Возвращает (сколько участников получили результат, кому не удалось отправить).
    Бросает DrawError, если жеребьёвку провести нельзя. (0, []) — если её уже провели.
    """
    members = await db.list_participants(game.id)
    exclusions = await db.list_exclusions(game.id)
    pairs = make_assignment([p.id for p in members], [(x.a.id, x.b.id) for x in exclusions])
    if not await db.save_draw(game.id, pairs):
        return 0, []
    game = await db.get_game(game.id)
    by_id = {p.id: p for p in members}
    delivered, failed = 0, []
    for santa_id, recipient_id in pairs.items():
        if await send_assignment(bot, game, by_id[santa_id], by_id[recipient_id]):
            delivered += 1
        else:
            failed.append(by_id[santa_id])
    return delivered, failed


async def nudge_wishlists(bot: Bot, db: Database, game: Game) -> int:
    """Напоминает заполнить ТЗ тем, у кого вишлист пустой."""
    sent = 0
    deadline = f" Жеребьёвка — {dates.fmt(game.draw_at)}." if game.draw_at else ""
    for p in await db.list_participants(game.id):
        if p.wishlist.strip():
            continue
        if await safe_send(
            bot, p.user_id,
            f"🔔 <b>Ваше ТЗ для Санты пустует</b>\n\nИгра «{texts.e(game.title)}».{deadline}\n"
            "Санте будет проще, если вы напишете хотя бы пару идей — что любите, а что дарить не стоит.",
            kb.markup([kb.btn("✏️ Заполнить ТЗ", kb.G(action="wish", game_id=game.id))]),
        ):
            sent += 1
    return sent


# ---------- аналитика ----------

def quarter(now: datetime) -> str:
    return f"Q{(now.month - 1) // 3 + 1} {now.year}"


async def build_report(db: Database, game: Game, now: datetime) -> tuple[list[tuple[str, str, str]], str]:
    members = await db.list_participants(game.id)
    n = len(members) or 1
    with_wish = sum(1 for p in members if p.wishlist.strip())
    ready = sum(1 for p in members if p.gift_ready)
    talks = sum(p.msgs_sent for p in members)

    kpis = [("Заполняемость ТЗ", f"{round(100 * with_wish / n)}%", f"{with_wish} из {len(members)} резидентов")]
    lines = [
        "📊 <b>NF Research · Обзор рынка подарков</b>",
        f"«{texts.e(game.title)}» · {quarter(now)}",
        "",
        f"👥 Резидентов: <b>{len(members)}</b>",
        f"📝 Заполняемость ТЗ: {humor.bar(with_wish / n)} {round(100 * with_wish / n)}%",
    ]
    if game.is_drawn:
        kpis.append(("Индекс готовности", f"{round(100 * ready / n)}%", "подарков готово"))
        lines.append(f"🎁 Индекс готовности подарков: {humor.bar(ready / n)} {round(100 * ready / n)}%")
    else:
        kpis.append(("Стадия", "PRE", "сделка в работе"))
    kpis.append(("Переговоры", str(talks), "анонимных сообщений"))
    lines.append(f"💬 Анонимных переговоров: <b>{talks}</b>")
    if c := texts.countdown(game, now):
        lines.append(c)

    if top := humor.top_wishes([p.wishlist for p in members]):
        lines += ["", "🔥 <b>Спрос</b> (топ запросов в ТЗ): " + ", ".join(texts.e(w) for w in top)]
    lines += ["", f"🔮 <b>Прогноз аналитиков:</b> {humor.forecast()}"]

    if game.is_revealed:
        pairs = await db.all_assignments(game.id)
        santa_of = {r: s for s, r in pairs.items()}
        by_id = {p.id: p for p in members}
        analysts = [p for p in members if p.guess_id and p.guess_id == santa_of.get(p.id)]
        masters = [by_id[santa_of[p.id]] for p in members if p.id in santa_of and p.guess_id != santa_of[p.id]]
        lines += ["", "🏆 <b>Номинации года</b>"]
        lines.append("🎯 Аналитики года (угадали Санту): "
                     + (", ".join(texts.e(p.name) for p in analysts) if analysts else "рынок оказался непредсказуем"))
        if masters:
            lines.append("🕶 Мастера конспирации (их не вычислили): " + ", ".join(texts.e(p.name) for p in masters))
        broker = max(members, key=lambda p: p.msgs_sent, default=None)
        if broker and broker.msgs_sent:
            lines.append(f"💬 Брокер года (больше всех переговоров): {texts.e(broker.name)} — {broker.msgs_sent}")

    lines += ["", "<i>Данные не являются публичной офертой.</i>"]
    return kpis, "\n".join(lines)


async def reveal_game(bot: Bot, db: Database, game: Game, now: datetime) -> int:
    """Раскрывает карты: каждому — кто был его Сантой, всем — итоги."""
    if not await db.reveal(game.id):
        return 0
    game = await db.get_game(game.id)
    members = await db.list_participants(game.id)
    by_id = {p.id: p for p in members}
    santa_of = {r: s for s, r in (await db.all_assignments(game.id)).items()}
    sent = 0
    for p in members:
        santa = by_id.get(santa_of.get(p.id))
        if not santa:
            continue
        guessed = None if not p.guess_id else p.guess_id == santa.id
        verdict = {True: "🎯 Вы угадали — аналитик года!",
                   False: f"🕶 Ваш прогноз был: {texts.e(by_id[p.guess_id].name) if p.guess_id in by_id else '—'}. "
                          "Конспирация класса А+!",
                   None: "Вы не делали прогноз — рынок непредсказуем 🙂"}[guessed]
        if await send_card(bot, p.user_id, cards.reveal_card, santa.name, guessed, game.title,
                           caption=f"🎭 <b>Карты раскрыты!</b>\n\nВашим Тайным Сантой был(а) {texts.mention(santa)}.\n"
                                   f"{verdict}",
                           reply_markup=kb.markup([kb.btn("🙏 Сказать спасибо", kb.G(action="msg_s", game_id=game.id))])):
            sent += 1
    _, report = await build_report(db, game, now)
    recipients = {p.user_id for p in members} | {game.organizer_id}
    for uid in recipients:
        await safe_send(bot, uid, report)
    return sent
