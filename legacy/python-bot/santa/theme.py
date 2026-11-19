"""Фирменный стиль NF Group: тёмно-синий и бежевый, Montserrat тонкий заглавными,
логотип белый (на синем) или красный (на бежевом).

Точные значения цветов из брендбука можно подставить через .env
(BRAND_NAVY, BRAND_BEIGE, BRAND_RED …) — карточки перерисуются автоматически.
Настоящий логотип: положите PNG с прозрачным фоном в santa/assets/logo_white.png
и santa/assets/logo_red.png — он заменит текстовый.
"""

import os
from pathlib import Path

ASSETS = Path(__file__).parent / "assets"
FONTS = ASSETS / "fonts"

LOGO_WHITE = Path(os.getenv("BRAND_LOGO_WHITE", ASSETS / "logo_white.png"))
LOGO_RED = Path(os.getenv("BRAND_LOGO_RED", ASSETS / "logo_red.png"))


def _hex(name: str, default: str) -> tuple[int, int, int]:
    value = os.getenv(name, default).strip().lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


NAVY = _hex("BRAND_NAVY", "#13213A")
NAVY_DEEP = _hex("BRAND_NAVY_DEEP", "#0C1628")
BEIGE = _hex("BRAND_BEIGE", "#E6DCCB")
BEIGE_DEEP = _hex("BRAND_BEIGE_DEEP", "#D3C4AC")
RED = _hex("BRAND_RED", "#C8102E")
WHITE = (255, 255, 255)

WORDMARK = os.getenv("BRAND_WORDMARK", "NF GROUP")

FONT_THIN = FONTS / "Montserrat-Thin.ttf"
FONT_EXTRALIGHT = FONTS / "Montserrat-ExtraLight.ttf"
FONT_LIGHT = FONTS / "Montserrat-Light.ttf"
FONT_REGULAR = FONTS / "Montserrat-Regular.ttf"
FONT_MEDIUM = FONTS / "Montserrat-Medium.ttf"


def mix(a, b, t: float):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


class Scheme:
    """Две фирменные схемы: синяя (белый логотип) и бежевая (красный логотип)."""

    def __init__(self, bg, fg, muted, line, logo_color, logo_file):
        self.bg, self.fg, self.muted, self.line = bg, fg, muted, line
        self.logo_color, self.logo_file = logo_color, logo_file


DARK = Scheme(bg=NAVY, fg=BEIGE, muted=mix(BEIGE, NAVY, 0.45), line=mix(BEIGE, NAVY, 0.7),
              logo_color=WHITE, logo_file=LOGO_WHITE)
LIGHT = Scheme(bg=BEIGE, fg=NAVY, muted=mix(NAVY, BEIGE, 0.45), line=mix(NAVY, BEIGE, 0.7),
               logo_color=RED, logo_file=LOGO_RED)
