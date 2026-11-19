"""Разбор и красивый вывод дат на русском."""

import re
from datetime import date, datetime, time, timedelta

MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря"]
WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
_MONTH_STEMS = {m[:3]: i + 1 for i, m in enumerate(MONTHS)}
_MONTH_STEMS["мая"] = 5
_MONTH_STEMS["май"] = 5

_TIME = re.compile(r"(?<!\d)([01]?\d|2[0-3])[:.](\d{2})(?!\d)\s*$")
_NUMERIC = re.compile(r"^(\d{1,2})[./\-](\d{1,2})(?:[./\-](\d{2}|\d{4}))?$")
_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_WORDS = re.compile(r"^(\d{1,2})\s+([а-яё]+)\.?(?:\s+(\d{4}))?(?:\s*г\.?)?$")


class DateError(ValueError):
    pass


def parse_when(text: str, now: datetime) -> datetime:
    """«26.12», «26.12.2026 18:00», «26 декабря 18:30», «2026-12-26», «завтра 19:00».

    Без года — ближайшая такая дата в будущем. Без времени — 00:00
    (такое время считаем «не указано» и не показываем)."""
    raw = " ".join((text or "").lower().replace(",", " ").replace(" в ", " ").split())
    if not raw:
        raise DateError("пустая строка")

    t = time(0, 0)
    m = _TIME.search(raw)
    if m and not _NUMERIC.match(raw):  # «26.12» — это дата, а не время 26:12
        t = time(int(m.group(1)), int(m.group(2)))
        raw = raw[:m.start()].strip()

    today = now.date()
    if raw in ("сегодня", "завтра", "послезавтра"):
        d = today + timedelta(days=("сегодня", "завтра", "послезавтра").index(raw))
        return datetime.combine(d, t)

    year = None
    if m2 := _NUMERIC.match(raw):
        day, month, y = int(m2.group(1)), int(m2.group(2)), m2.group(3)
        year = (2000 + int(y) if len(y) == 2 else int(y)) if y else None
    elif m2 := _ISO.match(raw):
        year, month, day = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
    elif m2 := _WORDS.match(raw):
        day = int(m2.group(1))
        month = _MONTH_STEMS.get(m2.group(2)[:3])
        if not month:
            raise DateError(f"не знаю месяц «{m2.group(2)}»")
        year = int(m2.group(3)) if m2.group(3) else None
    else:
        raise DateError("не распознал дату")

    try:
        d = date(year or today.year, month, day)
        if year is None and d < today:
            d = date(today.year + 1, month, day)
    except ValueError as exc:
        raise DateError("такой даты нет") from exc
    return datetime.combine(d, t)


def has_time(dt: datetime) -> bool:
    return (dt.hour, dt.minute) != (0, 0)


def fmt(dt: datetime, with_weekday: bool = True) -> str:
    s = f"{dt.day} {MONTHS[dt.month - 1]}"
    if with_weekday:
        s += f" ({WEEKDAYS[dt.weekday()]})"
    if has_time(dt):
        s += f", {dt:%H:%M}"
    return s


def short(dt: datetime) -> str:
    s = f"{dt.day} {MONTHS[dt.month - 1]}"
    return s + (f", {dt:%H:%M}" if has_time(dt) else "")


def to_db(dt: datetime | None) -> str | None:
    return dt.strftime("%Y-%m-%dT%H:%M") if dt else None


def from_db(value: str | None) -> datetime | None:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M") if value else None


def plural(n: int, forms: tuple[str, str, str]) -> str:
    n = abs(n)
    if n % 10 == 1 and n % 100 != 11:
        return forms[0]
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return forms[1]
    return forms[2]


def days_word(n: int) -> str:
    return f"{n} {plural(n, ('день', 'дня', 'дней'))}"
