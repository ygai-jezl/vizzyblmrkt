"""Unit tests for the business profile before-model callback (pure: a stub request, no ADK)."""

from __future__ import annotations

import asyncio
import types

import pytest

from root_agent_pkg.callbacks import business_profile as cb
from root_agent_pkg.context import business_profile as bpc

VIEW = {"rev": 3, "brand": {"name": "Fernhill Plants"}, "answers": [{"q": "What you run", "a": "A shop or products"}], "facts": [], "more": 0}


class StubRequest:
    def __init__(self):
        self.appended = []

    def append_instructions(self, instructions):
        self.appended.append(list(instructions))
        return []


def _ctx(**state):
    base = {"tenantId": "ten_A", "userId": "usr_1", "ctxToken": "tok", "traceId": "tr1"}
    base.update(state)
    return types.SimpleNamespace(state=base)


def _run(ctx, req=None):
    req = req or StubRequest()
    out = asyncio.run(cb.apply_business_profile(callback_context=ctx, llm_request=req))
    assert out is None
    return req


@pytest.fixture(autouse=True)
def _empty_cache():
    bpc.cache_clear()
    yield
    bpc.cache_clear()


def _fetches(monkeypatch, result=VIEW):
    calls = []

    def fake(state, timeout=5):
        calls.append(dict(state))
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(cb.client, "fetch_chat_profile", fake)
    return calls


def test_fetches_once_per_rev_and_appends_the_block_every_call(monkeypatch):
    calls = _fetches(monkeypatch)
    ctx = _ctx(profileRev="3")
    first = _run(ctx)
    second = _run(ctx)
    assert len(calls) == 1 and calls[0] == {"ctxToken": "tok"}
    assert first.appended == second.appended
    assert "A shop or products" in first.appended[0][0]
    # A new rev reads it again.
    _run(_ctx(profileRev="4", traceId="tr2"))
    assert len(calls) == 2


def test_no_rev_appends_nothing_and_reads_nothing(monkeypatch):
    calls = _fetches(monkeypatch)
    for state in ({}, {"profileRev": ""}, {"profileRev": None}, {"profileRev": "3}]"}):
        assert _run(_ctx(**state)).appended == []
    assert calls == []


def test_a_failed_fetch_is_tried_once_per_turn(monkeypatch):
    calls = _fetches(monkeypatch, None)
    ctx = _ctx(profileRev="3")
    assert _run(ctx).appended == []
    assert _run(ctx).appended == []
    assert len(calls) == 1
    # The next turn (a new trace id) tries again.
    ctx.state["traceId"] = "tr2"
    _run(ctx)
    assert len(calls) == 2


def test_the_cache_is_per_person(monkeypatch):
    calls = _fetches(monkeypatch)
    _run(_ctx(profileRev="3"))
    _run(_ctx(profileRev="3", userId="usr_2"))
    assert len(calls) == 2


def test_never_raises(monkeypatch):
    _fetches(monkeypatch, RuntimeError("boom"))
    assert _run(_ctx(profileRev="3")).appended == []

    class Broken(StubRequest):
        def append_instructions(self, instructions):
            raise ValueError("no")

    _fetches(monkeypatch)
    bpc.cache_clear()
    _run(_ctx(profileRev="3", traceId="tr9"), Broken())
    assert asyncio.run(cb.apply_business_profile(callback_context=types.SimpleNamespace(state=None), llm_request=StubRequest())) is None


def test_an_empty_profile_appends_nothing_and_is_not_read_again(monkeypatch):
    calls = _fetches(monkeypatch, {"rev": 0, "answers": [], "facts": [], "more": 0})
    ctx = _ctx(profileRev="0")
    assert _run(ctx).appended == []
    ctx.state["traceId"] = "tr2"
    assert _run(ctx).appended == []
    assert len(calls) == 1


def test_keeps_no_founder_words_in_session_state(monkeypatch):
    _fetches(monkeypatch, {**VIEW, "facts": [{"kind": "goal", "label": "Goal", "text": "A hundred sign-ups by spring"}]})
    ctx = _ctx(profileRev="3")
    req = _run(ctx)
    assert "A hundred sign-ups by spring" in req.appended[0][0]
    assert "sign-ups" not in repr(ctx.state)
    assert set(ctx.state) == {"tenantId", "userId", "ctxToken", "traceId", "profileRev", "profileTried"}
