from aiogram.filters.callback_data import CallbackData


class Menu(CallbackData, prefix="m"):
    action: str  # home | games | new


class G(CallbackData, prefix="g"):
    """Действие внутри конкретной игры."""
    action: str
    game_id: int
    arg: int = 0
    arg2: int = 0
