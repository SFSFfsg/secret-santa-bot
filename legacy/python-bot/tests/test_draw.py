import random

import pytest

from santa.draw import DrawError, make_assignment


def check(pairs, ids, exclusions=()):
    assert set(pairs) == set(ids)
    assert sorted(pairs.values()) == sorted(ids)  # каждый получает ровно один подарок
    banned = {frozenset(p) for p in exclusions}
    for a, b in pairs.items():
        assert a != b
        assert frozenset((a, b)) not in banned


@pytest.mark.parametrize("n", [3, 4, 5, 10, 50, 200])
def test_basic(n):
    ids = list(range(1, n + 1))
    for seed in range(20):
        check(make_assignment(ids, rng=random.Random(seed)), ids)


def test_single_cycle_no_mutual_pairs():
    ids = list(range(10))
    pairs = make_assignment(ids, rng=random.Random(1))
    for a, b in pairs.items():
        assert pairs[b] != a
    # один общий круг
    seen, cur = set(), ids[0]
    while cur not in seen:
        seen.add(cur)
        cur = pairs[cur]
    assert len(seen) == len(ids)


def test_exclusions_respected():
    ids = list(range(1, 9))
    excl = [(1, 2), (3, 4), (5, 6), (1, 3)]
    for seed in range(50):
        check(make_assignment(ids, excl, rng=random.Random(seed)), ids, excl)


def test_tight_exclusions_use_fallback():
    # 1 может дарить только 2, а 2 — только 1: общий круг невозможен, но пары 1↔2 + круг 3→4→5→3 — можно.
    ids = [1, 2, 3, 4, 5]
    excl = [(1, 3), (1, 4), (1, 5), (2, 3), (2, 4), (2, 5)]
    check(make_assignment(ids, excl, rng=random.Random(0), attempts=50), ids, excl)


def test_impossible():
    with pytest.raises(DrawError):
        make_assignment([1, 2, 3], [(1, 2), (1, 3)])


def test_too_few():
    with pytest.raises(DrawError):
        make_assignment([1, 2])
