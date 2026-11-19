from aiogram import Router

from . import chat, common, fallback, organizer, participant


def setup_routers() -> Router:
    root = Router(name="root")
    # Порядок важен: команды → действия → «не понял».
    root.include_routers(common.router, organizer.router, participant.router, chat.router, fallback.router)
    return root
