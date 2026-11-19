"""Фирменные карточки-картинки в стиле NF Group (Pillow).

Сетка как у презентации объекта: логотип и метка сверху, тонкий заголовок
заглавными, строка «характеристик лота» и линейная иллюстрация ночного
делового квартала, на самой высокой башне которого — шапка Санты.
"""

import io
import random
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

from . import theme as t

W, H = 1280, 720
PAD = 72
SCALE = 2  # рисуем в 2× и уменьшаем — тонкие линии получаются гладкими


@lru_cache(maxsize=64)
def font(path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size * SCALE)


def S(v: float) -> int:
    return round(v * SCALE)


class Card:
    def __init__(self, scheme: t.Scheme):
        self.s = scheme
        self.img = Image.new("RGB", (W * SCALE, H * SCALE), scheme.bg)
        self.d = ImageDraw.Draw(self.img)

    # ---------- типографика ----------

    def text_width(self, text: str, f, tracking: float = 0) -> int:
        if not text:
            return 0
        return round(f.getlength(text) + S(tracking) * (len(text) - 1))

    def text(self, xy, text: str, f, fill, tracking: float = 0, anchor_right: bool = False):
        x, y = S(xy[0]), S(xy[1])
        if anchor_right:
            x -= self.text_width(text, f, tracking)
        if not tracking:
            self.d.text((x, y), text, font=f, fill=fill)
            return
        for ch in text:
            self.d.text((x, y), ch, font=f, fill=fill)
            x += f.getlength(ch) + S(tracking)

    def fit(self, text: str, path, max_width: float, size: int, min_size: int, tracking: float = 0,
            max_lines: int = 2) -> tuple[list[str], ImageFont.FreeTypeFont]:
        """Подбирает кегль и переносит строку так, чтобы заголовок влез."""
        for s in range(size, min_size - 1, -2):
            f = font(path, s)
            lines = self._wrap(text, f, S(max_width), tracking)
            if len(lines) <= max_lines:
                return lines, f
        f = font(path, min_size)
        lines = self._wrap(text, f, S(max_width), tracking)[:max_lines]
        lines[-1] = lines[-1].rstrip(" .,") + "…"
        return lines, f

    def _wrap(self, text, f, max_w, tracking):
        words, lines, cur = text.split(), [], ""
        for w in words:
            cand = f"{cur} {w}".strip()
            if self.text_width(cand, f, tracking) <= max_w or not cur:
                cur = cand
            else:
                lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
        return lines

    def line(self, x1, y1, x2, y2, fill=None, width: float = 1):
        self.d.line((S(x1), S(y1), S(x2), S(y2)), fill=fill or self.s.line, width=max(1, S(width)))

    # ---------- элементы ----------

    def logo(self, x=PAD, y=PAD - 8):
        """Белый логотип на синем, красный — на бежевом. PNG из assets, если он есть."""
        if self.s.logo_file.exists():
            logo = Image.open(self.s.logo_file).convert("RGBA")
            h = S(34)
            logo = logo.resize((round(logo.width * h / logo.height), h), Image.LANCZOS)
            self.img.paste(logo, (S(x), S(y)), logo)
            return
        self.text((x, y), t.WORDMARK, font(t.FONT_MEDIUM, 24), self.s.logo_color, tracking=7)

    def header(self, right_label: str):
        self.logo()
        self.text((W - PAD, PAD - 4), right_label.upper(), font(t.FONT_REGULAR, 13), self.s.muted,
                  tracking=4, anchor_right=True)
        self.line(PAD, PAD + 44, W - PAD, PAD + 44)

    def eyebrow(self, y, text: str, color=None):
        self.line(PAD, y + 9, PAD + 36, y + 9, fill=color or t.RED, width=1.5)
        self.text((PAD + 52, y), text.upper(), font(t.FONT_REGULAR, 14), color or self.s.fg, tracking=5)

    def headline(self, y, text: str, max_width=700, size=72, min_size=40, color=None, lines_max=2) -> float:
        lines, f = self.fit(text.upper(), t.FONT_THIN, max_width, size, min_size, tracking=3, max_lines=lines_max)
        lh = f.size / SCALE * 1.12
        for i, ln in enumerate(lines):
            self.text((PAD - 4, y + i * lh), ln, f, color or self.s.fg, tracking=3)
        return y + len(lines) * lh

    def specs(self, y, items: list[tuple[str, str]], width=720):
        """Строка характеристик лота: подпись мелко, значение тонко."""
        col = width / len(items)
        for i, (label, value) in enumerate(items):
            x = PAD + i * col
            if i:
                self.line(x - 24, y, x - 24, y + 64)
            self.text((x, y), label.upper(), font(t.FONT_REGULAR, 12), self.s.muted, tracking=3)
            lines, f = self.fit(value.upper(), t.FONT_LIGHT, col - 44, 22, 14, tracking=1.5, max_lines=2)
            for j, ln in enumerate(lines):
                self.text((x, y + 26 + j * 26), ln, f, self.s.fg, tracking=1.5)

    def footer(self, text: str):
        self.text((PAD, H - PAD + 18), text.upper(), font(t.FONT_REGULAR, 11), self.s.muted, tracking=4)

    def skyline(self, seed: int = 7, x0=820, x1=W - PAD + 10, base=H - PAD + 6, hat=True):
        """Линейный деловой квартал: контуры башен, тёплые окна, снег. На главной башне — шапка Санты."""
        rng = random.Random(seed)
        fg = self.s.fg
        win = t.mix(fg, self.s.bg, 0.15)
        win_off = t.mix(fg, self.s.bg, 0.78)
        towers = [(0, 70, 190), (64, 54, 270), (126, 92, 400), (230, 60, 300), (300, 78, 220), (388, 0, 0)]
        tallest = None
        for dx, w, h in towers:
            if not w:
                continue
            x, top = x0 + dx, base - h
            if x + w > x1:
                break
            self.d.rectangle((S(x), S(top), S(x + w), S(base)), outline=fg, width=S(1))
            # окна
            for wy in range(int(top) + 16, base - 16, 18):
                for wx in range(x + 10, x + w - 12, 14):
                    lit = rng.random() < 0.22
                    self.d.rectangle((S(wx), S(wy), S(wx + 5), S(wy + 8)), fill=win if lit else win_off)
            if tallest is None or h > tallest[2]:
                tallest = (x, w, h)
        # шпиль главной башни
        x, w, h = tallest
        cx, top = x + w / 2, base - h
        self.line(cx, top, cx, top - 46, fill=fg)
        if hat:
            self._santa_hat(cx, top - 46)
        self.line(x0 - 30, base, x1, base, fill=fg)
        # снег
        for _ in range(70):
            sx, sy = rng.uniform(x0 - 120, x1), rng.uniform(PAD + 70, base - 10)
            r = rng.choice((1, 1, 1.5, 2))
            self.d.ellipse((S(sx - r), S(sy - r), S(sx + r), S(sy + r)), fill=t.mix(fg, self.s.bg, 0.35))

    def _santa_hat(self, cx, tip_y):
        red, white = t.RED, t.WHITE if self.s is t.DARK else t.mix(t.WHITE, t.BEIGE, 0.2)
        # колпак, наклонённый вбок, как будто надет на шпиль
        self.d.polygon([(S(cx - 20), S(tip_y + 12)), (S(cx + 20), S(tip_y + 12)), (S(cx + 30), S(tip_y - 30)),
                        (S(cx + 4), S(tip_y - 22))], fill=red)
        self.d.rounded_rectangle((S(cx - 24), S(tip_y + 6), S(cx + 24), S(tip_y + 18)), radius=S(6), fill=white)
        self.d.ellipse((S(cx + 24), S(tip_y - 38), S(cx + 38), S(tip_y - 24)), fill=white)

    def stamp(self, cx, cy, top: str, bottom: str, color=t.RED, angle=-14):
        """Круглая печать «согласовано» — пасхалка про документооборот."""
        size = S(220)
        layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        c = size / 2
        for r, wdt in ((c - S(4), S(3)), (c - S(18), S(1))):
            d.ellipse((c - r, c - r, c + r, c + r), outline=color + (235,), width=wdt)
        f_big = font(t.FONT_MEDIUM, 24)
        f_small = font(t.FONT_REGULAR, 13)
        for txt, f, dy in ((top, f_small, -40), ("NF", f_big, -12), (bottom, f_small, 26)):
            w = f.getlength(txt)
            d.text((c - w / 2, c + S(dy)), txt, font=f, fill=color + (235,))
        layer = layer.rotate(angle, resample=Image.BICUBIC)
        self.img.paste(layer, (S(cx) - size // 2, S(cy) - size // 2), layer)

    def png(self) -> bytes:
        out = self.img.resize((W, H), Image.LANCZOS)
        buf = io.BytesIO()
        out.save(buf, "PNG", optimize=True)
        return buf.getvalue()


# ---------- карточки ----------

def welcome_card(year: int) -> bytes:
    c = Card(t.DARK)
    c.header(f"Secret Santa · {year}")
    c.eyebrow(190, "Новогодний проект")
    y = c.headline(232, "Тайный Санта", size=84)
    c.text((PAD, y + 18), "ОБЪЕКТ КЛАССА А+ ДЛЯ ОБМЕНА ПОДАРКАМИ", font(t.FONT_LIGHT, 18), c.s.fg, tracking=3)
    c.specs(510, [("Комиссия", "0%"), ("Локация", "офис и сердца"), ("Сдача объекта", "к Новому году")])
    c.skyline(seed=year)
    c.footer("Конфиденциально · только для резидентов")
    return c.png()


def invite_card(title: str, budget: str, when: str, residents: int, lot: int) -> bytes:
    c = Card(t.DARK)
    c.header(f"Лот № {lot:04d}")
    c.eyebrow(180, "Эксклюзивное предложение")
    c.headline(222, title, max_width=640, size=64, min_size=36)
    c.specs(470, [("Бюджет", budget), ("Дата сделки", when), ("Резидентов", str(residents))])
    c.skyline(seed=lot)
    c.footer("Тайный Санта · приглашение коллегам")
    return c.png()


def assignment_card(title: str, recipient: str, budget: str, when: str, contract: str) -> bytes:
    c = Card(t.LIGHT)
    c.header(f"Договор № {contract}")
    c.eyebrow(178, "Сделка закрыта")
    c.text((PAD, 226), "ВЫ — ТАЙНЫЙ САНТА ДЛЯ", font(t.FONT_LIGHT, 22), c.s.muted, tracking=4)
    c.headline(264, recipient, max_width=740, size=74, min_size=40, color=t.NAVY)
    c.specs(470, [("Бюджет", budget), ("Дата сделки", when), ("Гриф", "строго конфиденциально")], width=760)
    c.stamp(1030, 330, "СОГЛАСОВАНО", "СЕВЕРНЫЙ ПОЛЮС")
    c.footer(title)
    return c.png()


def reveal_card(santa: str, guessed: bool | None, title: str) -> bytes:
    c = Card(t.DARK)
    c.header("Раскрытие информации")
    c.eyebrow(178, "Due diligence завершён")
    c.text((PAD, 226), "ВАШИМ ТАЙНЫМ САНТОЙ БЫЛ(А)", font(t.FONT_LIGHT, 22), c.s.muted, tracking=4)
    c.headline(264, santa, max_width=700, size=74, min_size=40)
    verdict = {True: "Вы угадали — аналитик года",
               False: "Не угадали — конспирация класса А+",
               None: "Без прогноза — рынок непредсказуем"}[guessed]
    c.text((PAD, 470), verdict.upper(), font(t.FONT_LIGHT, 20), c.s.fg, tracking=3)
    c.skyline(seed=len(santa))
    c.footer(title)
    return c.png()


def research_card(title: str, kpis: list[tuple[str, str, str]], quarter: str) -> bytes:
    """Обложка «Обзора рынка подарков» — пародия на аналитический отчёт."""
    c = Card(t.LIGHT)
    c.header(f"NF Research · {quarter}")
    c.eyebrow(172, "Обзор рынка подарков")
    c.headline(212, title, max_width=1100, size=52, min_size=32, color=t.NAVY, lines_max=1)
    n = len(kpis)
    col = (W - 2 * PAD) / n
    for i, (label, value, sub) in enumerate(kpis):
        x = PAD + i * col
        if i:
            c.line(x - 20, 330, x - 20, 560)
        c.text((x, 330), label.upper(), font(t.FONT_REGULAR, 13), c.s.muted, tracking=3)
        c.text((x - 4, 360), value, font(t.FONT_THIN, 96), t.NAVY)
        c.text((x, 500), sub.upper(), font(t.FONT_LIGHT, 14), c.s.fg, tracking=2)
    c.line(PAD, 600, W - PAD, 600)
    c.footer("Данные не являются публичной офертой · прогноз носит праздничный характер")
    return c.png()


def avatar() -> bytes:
    """Аватар бота для @BotFather: синий фон, башня в шапке Санты."""
    size = 640
    img = Image.new("RGB", (size * SCALE, size * SCALE), t.NAVY)
    card = Card(t.DARK)
    card.img, card.d = img, ImageDraw.Draw(img)
    card.skyline(seed=3, x0=150, x1=520, base=520)
    f = font(t.FONT_MEDIUM, 34)
    w = card.text_width(t.WORDMARK, f, 8) / SCALE
    card.text(((size - w) / 2, 560), t.WORDMARK, f, t.WHITE, tracking=8)
    out = img.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return buf.getvalue()
