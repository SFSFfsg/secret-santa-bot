import pytest

from santa.handlers import chat, common, fallback, organizer, participant


@pytest.fixture(autouse=True)
def detach_routers():
    """Роутеры — модульные объекты; в одном процессе тесты создают несколько Dispatcher."""
    yield
    for module in (chat, common, fallback, organizer, participant):
        module.router._parent_router = None
