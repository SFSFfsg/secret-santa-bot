from aiogram.fsm.state import State, StatesGroup


class CreateGame(StatesGroup):
    title = State()
    budget = State()
    date = State()
    place = State()
    draw = State()


class EditGame(StatesGroup):
    value = State()


class Join(StatesGroup):
    name = State()
    wishlist = State()


class EditProfile(StatesGroup):
    name = State()
    wishlist = State()


class AnonChat(StatesGroup):
    message = State()


class Broadcast(StatesGroup):
    message = State()
