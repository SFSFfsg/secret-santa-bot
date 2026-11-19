from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import BotCommand

from .config import Config
from .db import Database
from .handlers import setup_routers

COMMANDS = [
    BotCommand(command="menu", description="Главное меню"),
    BotCommand(command="games", description="Мои игры"),
    BotCommand(command="new", description="Открыть новую игру"),
    BotCommand(command="idea", description="Идея подарка"),
    BotCommand(command="cancel", description="Отменить действие"),
    BotCommand(command="help", description="Помощь"),
]


def create_bot(config: Config, **kwargs) -> Bot:
    return Bot(config.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML), **kwargs)


def create_dispatcher(config: Config, db: Database, bot_username: str) -> Dispatcher:
    dp = Dispatcher(storage=MemoryStorage())
    dp["config"] = config
    dp["db"] = db
    dp["bot_username"] = bot_username
    dp.include_router(setup_routers())
    return dp
