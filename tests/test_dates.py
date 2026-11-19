from datetime import datetime

import pytest

from santa.dates import DateError, days_word, fmt, parse_when

NOW = datetime(2026, 11, 19, 15, 30)


@pytest.mark.parametrize("text, expected", [
    ("26.12", datetime(2026, 12, 26)),
    ("26.12 18:00", datetime(2026, 12, 26, 18, 0)),
    ("26.12.2026 в 18:30", datetime(2026, 12, 26, 18, 30)),
    ("26/12/26", datetime(2026, 12, 26)),
    ("26 декабря", datetime(2026, 12, 26)),
    ("26 дек 19:00", datetime(2026, 12, 26, 19, 0)),
    ("1 мая", datetime(2027, 5, 1)),
    ("15.01", datetime(2027, 1, 15)),        # январь уже прошёл → следующий год
    ("2026-12-25", datetime(2026, 12, 25)),
    ("завтра 19:00", datetime(2026, 11, 20, 19, 0)),
    ("Сегодня", datetime(2026, 11, 19)),
])
def test_parse(text, expected):
    assert parse_when(text, NOW) == expected


@pytest.mark.parametrize("text", ["", "когда-нибудь", "32.12", "30 февраля", "26 снежабря"])
def test_parse_errors(text):
    with pytest.raises(DateError):
        parse_when(text, NOW)


def test_format():
    assert fmt(datetime(2026, 12, 26, 18, 0)) == "26 декабря (сб), 18:00"
    assert fmt(datetime(2026, 12, 26)) == "26 декабря (сб)"
    assert [days_word(n) for n in (1, 2, 5, 11, 21, 22)] == ["1 день", "2 дня", "5 дней", "11 дней", "21 день", "22 дня"]
