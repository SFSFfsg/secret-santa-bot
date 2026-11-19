"""Жеребьёвка: кто кому дарит подарок."""

import random
from typing import Iterable, Sequence


class DrawError(Exception):
    pass


MIN_PARTICIPANTS = 3


def make_assignment(
    ids: Sequence[int],
    exclusions: Iterable[tuple[int, int]] = (),
    rng: random.Random | None = None,
    attempts: int = 3000,
) -> dict[int, int]:
    """Возвращает словарь {санта: подопечный}.

    Сначала пытаемся построить один общий круг (A→B→C→…→A): так никто не дарит
    друг другу «взаимно» и цепочка выглядит честно. Пары из `exclusions`
    (например, супруги или руководитель-подчинённый) не дарят друг другу ни в
    одну сторону. Если общий круг с исключениями не складывается, ищем любую
    перестановку без «сам себе» перебором.
    """
    ids = list(dict.fromkeys(ids))
    n = len(ids)
    if n < MIN_PARTICIPANTS:
        raise DrawError(f"Для жеребьёвки нужно минимум {MIN_PARTICIPANTS} участника.")

    rng = rng or random.SystemRandom()
    banned = {frozenset(p) for p in exclusions if p[0] != p[1]}

    def allowed(a: int, b: int) -> bool:
        return a != b and frozenset((a, b)) not in banned

    for _ in range(attempts):
        order = ids[:]
        rng.shuffle(order)
        pairs = {order[i]: order[(i + 1) % n] for i in range(n)}
        if all(allowed(a, b) for a, b in pairs.items()):
            return pairs

    result = _backtrack(ids, allowed, rng)
    if result is None:
        raise DrawError(
            "Не получается провести жеребьёвку с такими исключениями. "
            "Уберите часть исключений или добавьте участников."
        )
    return result


def _backtrack(ids, allowed, rng, step_limit: int = 200_000) -> dict[int, int] | None:
    options = {a: [b for b in ids if allowed(a, b)] for a in ids}
    if any(not v for v in options.values()):
        return None
    # Санта с наименьшим выбором — первым, это сильно сокращает перебор.
    santas = sorted(ids, key=lambda a: (len(options[a]), rng.random()))
    used: set[int] = set()
    result: dict[int, int] = {}
    steps = 0

    def go(i: int) -> bool:
        nonlocal steps
        if i == len(santas):
            return True
        steps += 1
        if steps > step_limit:
            return False
        santa = santas[i]
        candidates = [b for b in options[santa] if b not in used]
        rng.shuffle(candidates)
        for b in candidates:
            used.add(b)
            result[santa] = b
            if go(i + 1):
                return True
            used.discard(b)
            del result[santa]
        return False

    return result if go(0) else None
