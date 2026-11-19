from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
)
from aiogram.utils.keyboard import InlineKeyboardBuilder

from .callbacks import G, Menu
from .db import Exclusion, Game, Participant


def btn(text: str, cb) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, callback_data=cb.pack())


def markup(*rows: list[InlineKeyboardButton]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[list(r) for r in rows])


def main_menu(can_create: bool) -> InlineKeyboardMarkup:
    rows = [[btn("🎁 Мои игры", Menu(action="games"))]]
    if can_create:
        rows.append([btn("➕ Открыть новую игру", Menu(action="new"))])
    rows.append([btn("💡 Идея подарка", Menu(action="idea"))])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def games_list(games: list[Game], user_id: int, can_create: bool) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    icons = {"open": "🎲", "drawn": "🤝", "revealed": "🎭"}
    for g in games:
        mark = "👑 " if g.organizer_id == user_id else ""
        kb.row(btn(f"{icons.get(g.status, '•')} {mark}{g.title}", G(action="open", game_id=g.id)))
    if can_create:
        kb.row(btn("➕ Открыть новую игру", Menu(action="new")))
    kb.row(btn("⬅️ В меню", Menu(action="home")))
    return kb.as_markup()


def game_menu(game: Game, me: Participant | None, is_organizer: bool) -> InlineKeyboardMarkup:
    gid = game.id
    kb = InlineKeyboardBuilder()
    if me:
        if game.is_revealed:
            kb.row(btn("🎭 Кто был моим Сантой", G(action="whois", game_id=gid)))
            kb.row(btn("🎯 Мой подопечный", G(action="target", game_id=gid)))
            kb.row(btn("💌 Подопечному", G(action="msg_r", game_id=gid)),
                   btn("🙏 Спасибо Санте", G(action="msg_s", game_id=gid)))
        elif game.is_drawn:
            kb.row(btn("🎯 Мой подопечный", G(action="target", game_id=gid)))
            kb.row(btn("💌 Подопечному", G(action="msg_r", game_id=gid)),
                   btn("🎅 Своему Санте", G(action="msg_s", game_id=gid)))
            ready = "↩️ Подарок ещё не готов" if me.gift_ready else "✅ Подарок готов"
            kb.row(btn(ready, G(action="ready", game_id=gid, arg=0 if me.gift_ready else 1)),
                   btn("💡 Идея", G(action="idea", game_id=gid)))
            kb.row(btn("🕵️ Угадать своего Санту", G(action="guess", game_id=gid)))
        kb.row(btn("✏️ ТЗ (вишлист)", G(action="wish", game_id=gid)),
               btn("✏️ Имя", G(action="name", game_id=gid)))
        kb.row(btn("📊 Обзор рынка подарков", G(action="report", game_id=gid)))
        if game.is_open and not is_organizer:
            kb.row(btn("🚪 Выйти из игры", G(action="leave", game_id=gid)))
    elif game.is_open:
        kb.row(btn("✅ Участвовать", G(action="join", game_id=gid)))
    if is_organizer:
        kb.row(btn("⚙️ Управление лотом", G(action="admin", game_id=gid)))
    kb.row(btn("⬅️ Мои игры", Menu(action="games")))
    return kb.as_markup()


def join_invite(game: Game) -> InlineKeyboardMarkup:
    return markup([btn("✅ Участвую!", G(action="join", game_id=game.id))])


def admin_menu(game: Game, organizer_participates: bool) -> InlineKeyboardMarkup:
    gid = game.id
    kb = InlineKeyboardBuilder()
    kb.row(btn("👥 Резиденты", G(action="members", game_id=gid)),
           btn("📨 Приглашение", G(action="invite", game_id=gid)))
    if game.is_open:
        kb.row(btn("🚫 Исключения", G(action="excl", game_id=gid)),
               btn("✏️ Параметры лота", G(action="edit", game_id=gid)))
        kb.row(btn("🔔 Напомнить про ТЗ", G(action="nudge", game_id=gid)))
        if not organizer_participates:
            kb.row(btn("🙋 Участвовать самому", G(action="join", game_id=gid)))
        kb.row(btn("🎲 Провести жеребьёвку", G(action="draw", game_id=gid)))
    else:
        kb.row(btn("✏️ Дата и место", G(action="edit", game_id=gid)))
    if game.status == "drawn":
        kb.row(btn("🎭 Раскрыть карты", G(action="reveal", game_id=gid)))
    kb.row(btn("📢 Рассылка", G(action="bcast", game_id=gid)),
           btn("📊 Обзор рынка", G(action="report", game_id=gid)))
    kb.row(btn("🗑 Удалить игру", G(action="delete", game_id=gid)))
    kb.row(btn("⬅️ К игре", G(action="open", game_id=gid)))
    return kb.as_markup()


def edit_menu(game: Game, fields: dict[int, tuple[str, str]]) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    for key, (field, label) in fields.items():
        if not game.is_open and field in ("title", "budget", "draw_at"):
            continue
        kb.row(btn(f"✏️ {label.capitalize()}", G(action="edit_f", game_id=game.id, arg=key)))
    kb.row(btn("⬅️ Назад", G(action="admin", game_id=game.id)))
    return kb.as_markup()


def members_menu(game: Game, members: list[Participant]) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    if game.is_open:
        for p in members:
            kb.row(btn(f"❌ Удалить: {p.name}", G(action="kick", game_id=game.id, arg=p.id)))
    kb.row(btn("⬅️ Назад", G(action="admin", game_id=game.id)))
    return kb.as_markup()


def confirm(yes_cb, no_cb, yes_text: str = "✅ Да", no_text: str = "Отмена") -> InlineKeyboardMarkup:
    return markup([btn(yes_text, yes_cb), btn(no_text, no_cb)])


def exclusions_menu(game: Game, exclusions: list[Exclusion]) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    kb.row(btn("➕ Добавить пару", G(action="excl_a", game_id=game.id)))
    for ex in exclusions:
        kb.row(btn(f"🗑 {ex.a.name} ↔ {ex.b.name}", G(action="excl_del", game_id=game.id, arg=ex.id)))
    kb.row(btn("⬅️ Назад", G(action="admin", game_id=game.id)))
    return kb.as_markup()


def pick_member(game: Game, members: list[Participant], action: str, arg: int = 0, skip: int = 0,
                back: str = "excl", mark: int | None = None) -> InlineKeyboardMarkup:
    kb = InlineKeyboardBuilder()
    for p in members:
        if p.id == skip:
            continue
        cb = G(action=action, game_id=game.id, arg=arg, arg2=p.id) if arg else G(action=action, game_id=game.id, arg=p.id)
        kb.button(text=("🎯 " if p.id == mark else "") + p.name, callback_data=cb.pack())
    kb.adjust(2)
    kb.row(btn("⬅️ Назад", G(action=back, game_id=game.id)))
    return kb.as_markup()


def after_draw(game: Game) -> InlineKeyboardMarkup:
    return markup(
        [btn("💌 Написать подопечному", G(action="msg_r", game_id=game.id))],
        [btn("✅ Подарок готов", G(action="ready", game_id=game.id, arg=1)),
         btn("💡 Идея подарка", G(action="idea", game_id=game.id))],
        [btn("🎄 Открыть игру", G(action="open", game_id=game.id))],
    )


def reminder_buttons(game: Game, ready: bool) -> InlineKeyboardMarkup:
    rows = [[btn("🎯 Мой подопечный", G(action="target", game_id=game.id))]]
    if not ready:
        rows.append([btn("✅ Подарок готов", G(action="ready", game_id=game.id, arg=1)),
                     btn("💡 Идея подарка", G(action="idea", game_id=game.id))])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def reply_to(game: Game, direction: str) -> InlineKeyboardMarkup:
    text = "↩️ Ответить Санте" if direction == "s" else "↩️ Ответить подопечному"
    return markup([btn(text, G(action=f"msg_{direction}", game_id=game.id))])


def idea_more(game_id: int = 0) -> InlineKeyboardMarkup:
    more = G(action="idea", game_id=game_id) if game_id else Menu(action="idea")
    rows = [[btn("🎲 Ещё идею", more)]]
    if game_id:
        rows.append([btn("🎄 К игре", G(action="open", game_id=game_id))])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def guess_prompt(game: Game) -> InlineKeyboardMarkup:
    return markup([btn("🕵️ Угадать своего Санту", G(action="guess", game_id=game.id))])


def skip_button(game_id: int, action: str = "wish_skip", text: str = "Пропустить") -> InlineKeyboardMarkup:
    return markup([btn(text, G(action=action, game_id=game_id))])


def manual_draw_button() -> InlineKeyboardMarkup:
    return markup([btn("🖐 Проведу вручную", Menu(action="manual_draw"))])


def skip_place_button() -> InlineKeyboardMarkup:
    return markup([btn("Пропустить", Menu(action="skip_place"))])


def cancel_button(game_id: int) -> InlineKeyboardMarkup:
    return markup([btn("Отмена", G(action="open", game_id=game_id))])


def back_to_game(game_id: int) -> InlineKeyboardMarkup:
    return markup([btn("🎄 К игре", G(action="open", game_id=game_id))])


def name_suggestion(full_name: str) -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text=full_name[:64])]],
        resize_keyboard=True,
        one_time_keyboard=True,
        input_field_placeholder="Имя и фамилия",
    )
