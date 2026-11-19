import os
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None


@dataclass
class Config:
    bot_token: str
    db_path: str = "data/santa.db"
    company: str = "NF Group"
    admin_ids: set[int] = field(default_factory=set)
    timezone: str = "Europe/Moscow"
    reminder_hour: int = 11          # во сколько присылать напоминания
    draw_animation_delay: float = 0.7  # пауза между «этапами сделки» при жеребьёвке

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    def now(self) -> datetime:
        """Текущее местное время без tzinfo — в таком виде даты хранятся в базе."""
        return datetime.now(self.tz).replace(tzinfo=None, second=0, microsecond=0)

    def can_create_games(self, user_id: int) -> bool:
        return not self.admin_ids or user_id in self.admin_ids


def _parse_ids(raw: str) -> set[int]:
    ids = set()
    for chunk in raw.replace(";", ",").split(","):
        chunk = chunk.strip()
        if chunk:
            ids.add(int(chunk))
    return ids


def load_config() -> Config:
    if load_dotenv:
        load_dotenv()
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Не задан BOT_TOKEN. Скопируйте .env.example в .env и укажите токен от @BotFather.")
    return Config(
        bot_token=token,
        db_path=os.getenv("DB_PATH", "data/santa.db"),
        company=os.getenv("COMPANY_NAME", "NF Group").strip() or "NF Group",
        admin_ids=_parse_ids(os.getenv("ADMIN_IDS", "")),
        timezone=os.getenv("TZ_NAME", "Europe/Moscow"),
        reminder_hour=int(os.getenv("REMINDER_HOUR", "11")),
    )
