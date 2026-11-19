"""Напоминания и автоматические действия по расписанию."""

import asyncio
import logging
from datetime import datetime, time, timedelta

from aiogram import Bot

from . import dates
from . import keyboards as kb
from . import texts
from .config import Config
from .db import Database, Game
from .draw import MIN_PARTICIPANTS, DrawError
from .services import nudge_wishlists, run_draw, safe_send

log = logging.getLogger(__name__)

BEFORE = [("d7", 7), ("d3", 3), ("d1", 1), ("d0", 0)]
DRAW_KINDS = ["nudge_auto", "autodraw"]
EXCHANGE_KINDS = [k for k, _ in BEFORE] + ["guess_invite"]


def exchange_schedule(exchange_at: datetime, reminder_hour: int) -> dict[str, datetime]:
    """Когда отправлять каждое напоминание перед сделкой и приглашение угадать Санту."""
    day = exchange_at.date()
    plan = {k: datetime.combine(day - timedelta(days=n), time(reminder_hour)) for k, n in BEFORE if n}
    morning = datetime.combine(day, time(9))
    if dates.has_time(exchange_at):
        plan["d0"] = min(morning, exchange_at - timedelta(hours=2))
        plan["guess_invite"] = exchange_at + timedelta(hours=3)
    else:
        plan["d0"] = morning
        plan["guess_invite"] = datetime.combine(day + timedelta(days=1), time(reminder_hour))
    return plan


async def tick(bot: Bot, db: Database, config: Config, now: datetime | None = None) -> None:
    now = now or config.now()
    for game in await db.list_active_games():
        try:
            if game.is_open:
                await _before_draw(bot, db, game, now)
            elif game.exchange_at:
                await _before_exchange(bot, db, config, game, now)
        except Exception:
            log.exception("Ошибка планировщика в игре %s", game.id)


async def _before_draw(bot: Bot, db: Database, game: Game, now: datetime) -> None:
    if not game.draw_at:
        return
    if game.draw_at - timedelta(days=1) <= now < game.draw_at and await db.mark_reminder(game.id, "nudge_auto"):
        await nudge_wishlists(bot, db, game)
    if now < game.draw_at or not await db.mark_reminder(game.id, "autodraw"):
        return

    count = len(await db.list_participants(game.id))
    if count < MIN_PARTICIPANTS:
        await db.update_game(game.id, draw_at=None)
        await safe_send(bot, game.organizer_id,
                        f"⚠️ Автоматическая жеребьёвка в «{texts.e(game.title)}» не состоялась: "
                        f"резидентов {count}, а нужно минимум {MIN_PARTICIPANTS}. Проведите её вручную, когда соберётесь.",
                        kb.markup([kb.btn("⚙️ Управление лотом", kb.G(action="admin", game_id=game.id))]))
        return
    try:
        delivered, failed = await run_draw(bot, db, game)
    except DrawError as exc:
        await db.update_game(game.id, draw_at=None)
        await safe_send(bot, game.organizer_id, f"⚠️ Автожеребьёвка в «{texts.e(game.title)}»: {texts.e(str(exc))}")
        return
    report = f"🤖 Автоматическая жеребьёвка в «{texts.e(game.title)}» проведена! Результат получили {delivered} резидентов."
    if failed:
        report += "\n⚠️ Не удалось написать: " + ", ".join(texts.mention(p) for p in failed)
    await safe_send(bot, game.organizer_id, report)


async def _before_exchange(bot: Bot, db: Database, config: Config, game: Game, now: datetime) -> None:
    plan = exchange_schedule(game.exchange_at, config.reminder_hour)

    if now >= plan["guess_invite"]:
        if await db.mark_reminder(game.id, "guess_invite"):
            for kind, _ in BEFORE:  # устаревшие напоминания уже не нужны
                await db.mark_reminder(game.id, kind)
            await _guess_invite(bot, db, game)
        return

    end = game.exchange_at if dates.has_time(game.exchange_at) else datetime.combine(game.exchange_at.date(), time(23, 59))
    if now >= end:
        return
    due = [kind for kind, _ in BEFORE if plan[kind] <= now]
    if not due:
        return
    latest = due[-1]
    if not await db.mark_reminder(game.id, latest):
        return
    for kind in due[:-1]:  # если бот был выключен — шлём только самое актуальное
        await db.mark_reminder(game.id, kind)
    await _exchange_reminder(bot, db, game, dict(BEFORE)[latest])


async def _exchange_reminder(bot: Bot, db: Database, game: Game, days: int) -> None:
    for santa in await db.list_participants(game.id):
        recipient = await db.get_recipient(game.id, santa.id)
        if not recipient:
            continue
        who = texts.mention(recipient)
        if days == 0:
            text = (f"🎉 <b>Сегодня день сделки!</b>\n\n«{texts.e(game.title)}»\n📍 {texts.e(texts.when(game))}\n\n"
                    f"Не забудьте подарок для {who} 🎁")
        elif santa.gift_ready:
            text = (f"⏳ До сделки «{texts.e(game.title)}» — {dates.days_word(days)}.\n"
                    f"Подарок для {who} готов — отлично! Не забудьте взять его с собой: {texts.e(texts.when(game))}.")
        else:
            text = (f"⏳ <b>До сделки {dates.days_word(days)}</b>\n\n«{texts.e(game.title)}» · {texts.e(texts.when(game))}\n"
                    f"Ваш подопечный — {who}. Подарок уже готов?")
        await safe_send(bot, santa.user_id, text, kb.reminder_buttons(game, santa.gift_ready or days == 0))
        await asyncio.sleep(0.05)


async def _guess_invite(bot: Bot, db: Database, game: Game) -> None:
    for p in await db.list_participants(game.id):
        if p.guess_id:
            continue
        await safe_send(bot, p.user_id,
                        f"🎁 Подарки вручены? Время аналитики!\n\nИгра «{texts.e(game.title)}». "
                        "Попробуйте угадать, кто был вашим Тайным Сантой. Когда организатор раскроет карты, "
                        "узнаете, были ли вы правы. Самые точные получат номинацию «Аналитик года» 🏆",
                        kb.guess_prompt(game))
    await safe_send(bot, game.organizer_id,
                    f"🎭 Сделка «{texts.e(game.title)}» состоялась! Резиденты угадывают своих Сант. "
                    "Когда будете готовы — раскройте карты.",
                    kb.markup([kb.btn("🎭 Раскрыть карты", kb.G(action="reveal", game_id=game.id))],
                              [kb.btn("⚙️ Управление лотом", kb.G(action="admin", game_id=game.id))]))


async def scheduler_loop(bot: Bot, db: Database, config: Config, interval: float = 60) -> None:
    log.info("Планировщик напоминаний запущен (%s, напоминания в %s:00)", config.timezone, config.reminder_hour)
    while True:
        try:
            await tick(bot, db, config)
        except Exception:
            log.exception("Ошибка планировщика")
        await asyncio.sleep(interval)
