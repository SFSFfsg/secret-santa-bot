import asyncio
import logging

from .app import COMMANDS, create_bot, create_dispatcher
from .config import load_config
from .db import Database
from .scheduler import scheduler_loop


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load_config()
    db = Database(config.db_path)
    await db.connect()
    bot = create_bot(config)
    try:
        me = await bot.get_me()
        await bot.set_my_commands(COMMANDS)
        await bot.set_my_description(
            f"🎅 Тайный Санта {config.company} — новогодний объект класса А+. "
            "Анонимный обмен подарками с коллегами: жеребьёвка, вишлисты, напоминания и немного аналитики."
        )
        dp = create_dispatcher(config, db, me.username)
        logging.info("Бот @%s запущен", me.username)
        reminders = asyncio.create_task(scheduler_loop(bot, db, config))
        try:
            await dp.start_polling(bot)
        finally:
            reminders.cancel()
    finally:
        await bot.session.close()
        await db.close()


if __name__ == "__main__":
    asyncio.run(main())
