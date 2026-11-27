"""Unit tests for the Raise Ops client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.sub_agents.raise_ops.tools import raise_client as rc

CARD = {
    "kind": "raise_deck",
    "id": "rd_abcdefghij12",
    "title": "Acme pre-seed",
    "url": "/admin/raise/rd_abcdefghij12",
    "stats": [{"label": "slides", "value": 10}, {"label": "version", "value": 3}, {"label": "needs", "value": 2}],
    "warnings": 1,
}
OK = {"ok": True, "id": "rd_abcdefghij12", "status": "draft", "url": "/admin/raise/rd_abcdefghij12", "card": CARD, "warnings": [], "summary": "Saved version 3."}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, json.dumps(body if body is not None else OK)

    monkeypatch.setattr(rc, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def _no_call(monkeypatch):
    monkeypatch.setattr(rc, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))


def test_draft_posts_a_draft_with_only_what_was_given_and_the_token(monkeypatch):
    calls = _capture(monkeypatch)
    out = rc.draft({"ctxToken": "tok"}, " Investor ", "Pre-seed", "", "  For a round of £250,000  ")
    assert calls == [
        {
            "method": "POST",
            "url": "https://app.example.com/api/agent/canvas",
            "token": "tok",
            "payload": {"kind": "raise_deck", "action": "save_draft", "mode": "draft", "audience": "investor", "stage": "pre_seed", "brief": "For a round of £250,000"},
        }
    ]
    assert out == {"status": "success", "docId": "rd_abcdefghij12", "version": 3, "url": "/admin/raise/rd_abcdefghij12", "card": CARD, "warnings": [], "message": "Saved version 3."}


def test_a_lender_pack_never_carries_a_stage(monkeypatch):
    calls = _capture(monkeypatch)
    rc.draft({"ctxToken": "tok"}, "lender", "seed", "Fernhill stock loan")
    assert calls[0]["payload"] == {"kind": "raise_deck", "action": "save_draft", "mode": "draft", "audience": "lender", "title": "Fernhill stock loan"}


def test_draft_asks_which_kind_before_it_calls(monkeypatch):
    _no_call(monkeypatch)
    assert rc.draft({"ctxToken": "tok"}, "bank", "")["status"] == "needs_audience"


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    _no_call(monkeypatch)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert rc.draft({}, "investor")["status"] == "unavailable"
    assert rc.get({})["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert rc.revise({"ctxToken": "tok"}, {"change": "refresh_numbers"})["status"] == "unavailable"


def test_get_reads_the_deck_named_else_the_one_in_view_else_none(monkeypatch):
    calls = _capture(monkeypatch, body={"doc": {"id": "rd_abcdefghij12"}, "meanings": {}, "note": "Read only."})
    out = rc.get({"ctxToken": "tok", "raiseDocId": "rd_abcdefghij12"})
    assert out == {"status": "success", "doc": {"id": "rd_abcdefghij12"}, "meanings": {}, "note": "Read only."}
    rc.get({"ctxToken": "tok", "raiseDocId": "rd_abcdefghij12"}, "rd_zzzzzzzzzzzz")
    rc.get({"ctxToken": "tok", "raiseDocId": ""})
    assert [c["method"] for c in calls] == ["GET", "GET", "GET"]
    assert [c["url"] for c in calls] == [
        "https://app.example.com/api/agent/raise/docs?docId=rd_abcdefghij12",
        "https://app.example.com/api/agent/raise/docs?docId=rd_zzzzzzzzzzzz",
        "https://app.example.com/api/agent/raise/docs",
    ]
    assert all(c["payload"] is None and c["token"] == "tok" for c in calls)


def test_each_change_carries_only_its_own_fields():
    assert rc.build_op("rewrite", slide=5, ask=" Lead with the weekly growth ", layout="chart") == {"change": "rewrite", "slide": 5, "ask": "Lead with the weekly growth"}
    assert rc.build_op("Add", after=0, section="Why now") == {"change": "add", "after": 0, "section": "why_now"}
    assert rc.build_op("move", slide=5, to=2, ask="x") == {"change": "move", "slide": 5, "to": 2}
    assert rc.build_op("layout", slide=3, layout="Big number") == {"change": "layout", "slide": 3, "layout": "big_number"}
    assert rc.build_op("number", slide=4, meaning="waitlistSignups", weeks=7) == {"change": "number", "slide": 4, "meaning": "waitlistSignups"}
    assert rc.build_op("number", slide=6, meaning="launchSignups", weeks=8, launch="Acme beta") == {"change": "number", "slide": 6, "meaning": "launchSignups", "weeks": 8, "launch": "Acme beta"}
    assert rc.build_op("refresh_numbers", slide=3) == {"change": "refresh_numbers"}
    assert rc.build_op("send") is None


def test_a_typed_number_keeps_the_persons_words_and_a_zero(monkeypatch):
    op = rc.build_op("typed_number", slide=4, name="MRR", value=6200, unit="Money", currency="usd", per="Month", source_note="Stripe", quote="our MRR is $6,200")
    assert op == {"change": "typed_number", "slide": 4, "name": "MRR", "value": 6200, "unit": "money", "currency": "USD", "per": "month", "from": "Stripe", "quote": "our MRR is $6,200"}
    assert rc.build_op("typed_number", slide=2, name="Debt", value=0, unit="money", quote="we owe 0")["value"] == 0


def test_revise_sends_one_change_for_the_deck_in_view_and_the_version_read(monkeypatch):
    calls = _capture(monkeypatch)
    out = rc.revise({"ctxToken": "tok", "raiseDocId": "rd_abcdefghij12"}, {"change": "remove", "slide": 2}, "Took out the problem slide.", 2)
    assert calls[0]["payload"] == {
        "kind": "raise_deck",
        "action": "save_draft",
        "mode": "revise",
        "ops": [{"change": "remove", "slide": 2}],
        "scope": {"kind": "raise_deck", "docId": "rd_abcdefghij12"},
        "baseVersion": 2,
        "note": "Took out the problem slide.",
    }
    assert out["status"] == "success" and out["version"] == 3 and out["card"] == CARD
    # No deck in view and none named: the newest, picked by the app.
    rc.revise({"ctxToken": "tok"}, {"change": "refresh_numbers"})
    assert "scope" not in calls[1]["payload"] and "baseVersion" not in calls[1]["payload"]


def test_an_unknown_change_never_calls(monkeypatch):
    _no_call(monkeypatch)
    assert rc.revise({"ctxToken": "tok"}, None)["code"] == "invalid_change"


def test_a_change_that_names_a_slide_needs_the_version_read(monkeypatch):
    _no_call(monkeypatch)
    for op in ({"change": "remove", "slide": 3}, {"change": "rewrite", "slide": 3, "ask": "Shorter"}, {"change": "add", "after": 2, "section": "product"}):
        out = rc.revise({"ctxToken": "tok", "raiseDocId": "rd_abcdefghij12"}, op)
        assert out == {"status": "needs_version", "message": "Read the deck with get_raise_doc first, then pass the version it shows."}, op


def test_errors_become_plain_messages(monkeypatch):
    cases = [
        (503, {"error": "unavailable"}, "Decks from chat aren't switched on in this environment yet."),
        (404, {}, "Decks from chat aren't switched on in this environment yet."),
        (403, {"error": "not_included"}, "The Raise kit isn't included in this brand's plan."),
        (403, {"error": "forbidden"}, "Only an admin can make or change a deck."),
        (404, {"error": "doc_not_found"}, "I couldn't find that deck. Ask me to list your decks."),
        (409, {"error": "stale_version", "version": 4}, "Someone saved a newer version of this deck. I'll read it again before changing it."),
        (409, {"error": "deck_limit"}, "This brand has 20 decks, the most it can keep. Delete one to make another."),
        (429, {"error": "rate_limited"}, "I've drafted several decks just now. Please try again in a few minutes."),
        (422, {"error": "quote_mismatch"}, "That number isn't in what the person said. Ask them for it and pass their own words."),
        (503, {"error": "canvas_auth_unconfigured"}, "Decks from chat aren't set up in this environment yet."),
        (401, {"error": "unauthorized"}, "My session to the app expired. Please send your message again."),
        (502, {"error": "revise_failed"}, "I couldn't do that just now. Please try again."),
    ]
    for status, body, message in cases:
        _capture(monkeypatch, status=status, body=body)
        out = rc.revise({"ctxToken": "tok"}, {"change": "refresh_numbers"})
        assert out["status"] == "error" and out["message"] == message, (status, body)
    _capture(monkeypatch, status=422, body={"error": "invalid_ops", "issues": ["ops.0: there is no slide 11, the deck has 10"]})
    out = rc.revise({"ctxToken": "tok"}, {"change": "remove", "slide": 11}, version=3)
    assert out["message"] == "Some of that change wasn't valid: ops.0: there is no slide 11, the deck has 10"
    assert out["code"] == "invalid_ops" and out["issues"] == ["ops.0: there is no slide 11, the deck has 10"]
