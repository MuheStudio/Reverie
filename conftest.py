from __future__ import annotations

import asyncio
import inspect
from collections.abc import Generator

import pytest


def pytest_configure(config: pytest.Config) -> None:
    for marker in (
        "asyncio: async test executed by the built-in asyncio shim",
        "unit: unit-level test marker",
        "plugin_unit: plugin unit-level test marker",
        "plugin_e2e: plugin end-to-end test marker",
    ):
        config.addinivalue_line("markers", marker)


def _run_async(awaitable):
    return asyncio.run(awaitable)


def _fixture_kwargs(request: pytest.FixtureRequest, argnames: tuple[str, ...]) -> dict[str, object]:
    return {name: request.getfixturevalue(name) for name in argnames}


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem: pytest.Function) -> bool | None:
    testfunction = pyfuncitem.obj
    if not inspect.iscoroutinefunction(testfunction):
        return None

    kwargs = {name: pyfuncitem.funcargs[name] for name in pyfuncitem._fixtureinfo.argnames}
    _run_async(testfunction(**kwargs))
    return True


@pytest.hookimpl(tryfirst=True)
def pytest_fixture_setup(
    fixturedef: pytest.FixtureDef[object],
    request: pytest.FixtureRequest,
):
    func = fixturedef.func
    if inspect.iscoroutinefunction(func):
        kwargs = _fixture_kwargs(request, fixturedef.argnames)
        result = _run_async(func(**kwargs))
        fixturedef.cached_result = (result, None, None)
        return result

    if inspect.isasyncgenfunction(func):
        kwargs = _fixture_kwargs(request, fixturedef.argnames)
        agen = func(**kwargs)

        async def _get_first():
            return await agen.__anext__()

        result = _run_async(_get_first())

        def _finalizer() -> None:
            async def _close() -> None:
                try:
                    await agen.__anext__()
                except StopAsyncIteration:
                    return
                raise RuntimeError("async fixture yielded more than once")

            _run_async(_close())

        request.addfinalizer(_finalizer)
        fixturedef.cached_result = (result, None, None)
        return result

    return None
