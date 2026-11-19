from datetime import datetime
from html import escape

from . import dates
from .db import Game, Participant

MAX_NAME = 64
MAX_WISHLIST = 1500
MAX_TITLE = 80
MAX_FIELD = 120


def e(text: str | None) -> str:
    return escape(text or "")


def mention(p: Participant) -> str:
    name = f"<b>{e(p.name)}</b>"
    return f"{name} (@{e(p.username)})" if p.username else name


def wishlist_block(p: Participant) -> str:
    if p.wishlist.strip():
        return f"<blockquote expandable>{e(p.wishlist)}</blockquote>"
    return "<i>ТЗ пока не заполнено</i>"


def when(game: Game) -> str:
    """Дата и место обмена для текста."""
    base = dates.fmt(game.exchange_at) if game.exchange_at else game.exchange_date
    return f"{base} · {game.place}" if game.place else base


def when_short(game: Game) -> str:
    return dates.short(game.exchange_at) if game.exchange_at else game.exchange_date


def countdown(game: Game, now: datetime) -> str:
    if not game.exchange_at:
        return ""
    days = (game.exchange_at.date() - now.date()).days
    if days > 1:
        return f"⏳ До сделки: {dates.days_word(days)}"
    if days == 1:
        return "⏳ Сделка завтра!"
    if days == 0:
        return "🎉 Сделка сегодня!"
    return ""


def welcome(company: str) -> str:
    return (
        f"<b>ТАЙНЫЙ САНТА · {e(company.upper())}</b>\n\n"
        "Новогодний объект класса А+ для обмена подарками между коллегами.\n\n"
        "<b>Как проходит сделка</b>\n"
        "1. Организатор открывает лот и рассылает приглашение.\n"
        "2. Резиденты присоединяются и пишут ТЗ — вишлист.\n"
        "3. Бот проводит жеребьёвку и тайно сообщает каждому его подопечного.\n"
        "4. Санта и подопечный общаются анонимно — прямо через бота.\n"
        "5. В день сделки вручаем подарки, а потом угадываем своих Сант.\n\n"
        "Кто кому дарит, не знает никто, даже организатор. Конфиденциальность — как в сделке на 100 000 кв. м 🤫"
    )


HELP = (
    "<b>Команды</b>\n"
    "/menu — главное меню\n"
    "/games — мои игры\n"
    "/new — открыть новую игру\n"
    "/idea — идея подарка\n"
    "/cancel — отменить текущее действие\n\n"
    "Чтобы присоединиться к игре, откройте ссылку-приглашение от организатора.\n\n"
    "🥚 В боте спрятаны пасхалки. Подсказка: мы всё-таки консалтинговая компания."
)

STATUS = {"open": "🎲 идёт набор резидентов", "drawn": "🤝 сделки закрыты, ждём вручения",
          "revealed": "🎭 карты раскрыты"}


def game_header(game: Game, count: int, now: datetime | None = None) -> str:
    lines = [
        f"<b>{e(game.title.upper())}</b>",
        f"Лот № {game.id:04d}",
        "",
        f"💰 Бюджет: {e(game.budget)}",
        f"📅 Сделка: {e(when(game))}",
        f"👥 Резидентов: {count}",
        f"Статус: {STATUS.get(game.status, game.status)}",
    ]
    if game.is_open and game.draw_at:
        lines.append(f"🎲 Жеребьёвка: {dates.fmt(game.draw_at)}")
    if now and (c := countdown(game, now)):
        lines.append(c)
    return "\n".join(lines)


def game_card(game: Game, count: int, me: Participant | None, is_organizer: bool, now: datetime) -> str:
    parts = [game_header(game, count, now)]
    if me:
        parts.append(f"\n👤 Вы участвуете как: <b>{e(me.name)}</b>\n📝 Ваше ТЗ для Санты:\n{wishlist_block(me)}")
        if game.is_drawn and not game.is_revealed:
            parts.append("✅ Подарок готов" if me.gift_ready else "⏳ Подарок ещё не готов")
    elif is_organizer:
        parts.append("\nВы организатор, но сами не участвуете в обмене.")
    return "\n".join(parts)


def invite_link(bot_username: str, game: Game) -> str:
    return f"https://t.me/{bot_username}?start=join_{game.code}"


def invite_caption(game: Game, link: str | None = None) -> str:
    text = (
        f"🎅 <b>Приглашение в Тайного Санту</b>\n"
        f"«{e(game.title)}»\n\n"
        f"💰 Бюджет: {e(game.budget)}\n"
        f"📅 Сделка: {e(when(game))}"
    )
    if game.draw_at:
        text += f"\n🎲 Жеребьёвка: {dates.fmt(game.draw_at)}"
    if link:
        text += f"\n\nПрисоединиться: {link}"
    return text


def assignment_caption(game: Game, recipient: Participant) -> str:
    return (
        f"🤝 <b>Сделка закрыта!</b>\n\n"
        f"Вы — Тайный Санта для {mention(recipient)}.\n"
        f"💰 Бюджет: {e(game.budget)}\n"
        f"📅 Вручение: {e(when(game))}\n\n"
        "Гриф «строго конфиденциально» 🤫"
    )


def assignment_details(game: Game, recipient: Participant) -> str:
    return (
        f"📝 <b>ТЗ от подопечного</b> ({e(recipient.name)}):\n{wishlist_block(recipient)}\n\n"
        "Если что-то непонятно — задайте вопрос анонимно. Когда подарок будет куплен, "
        "нажмите «✅ Подарок готов»: напоминания станут мягче, а подопечному будет приятно."
    )
