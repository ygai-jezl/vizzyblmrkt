"""Unit tests for Lifecycle Ops' people fields client (ADK-free; HTTP monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.sub_agents.lifecycle_ops.tools import people_fields_client as pf

PERSON = "ct_" + "a" * 40


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(pf, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_lists_the_fields_with_the_session_token_and_remembers_they_are_on(monkeypatch):
    calls = _capture(monkeypatch, body={"fields": [{"id": "fld_1", "label": "Seats", "type": "number"}], "note": "Values: ..."})
    state = {"ctxToken": "tok"}
    out = pf.list_fields(state)
    assert out == {"status": "success", "fields": [{"id": "fld_1", "label": "Seats", "type": "number"}], "note": "Values: ..."}
    assert calls == [{"method": "GET", "url": "https://app.example.com/api/agent/audience/fields", "token": "tok", "payload": None}]
    assert state["personFieldsEnabled"] is True


def test_reads_the_person_in_view_unless_another_is_named(monkeypatch):
    calls = _capture(monkeypatch, body={"personId": PERSON, "fields": [{"id": "fld_1", "value": 12}], "waiting": ["fld_1"]})
    state = {"ctxToken": "tok", "personId": PERSON}
    out = pf.read_person(state, "")
    assert out["status"] == "success" and out["fields"] == [{"id": "fld_1", "value": 12}] and out["waiting"] == ["fld_1"]
    assert calls[-1]["url"] == f"https://app.example.com/api/agent/audience/people/{PERSON}/fields"
    pf.read_person(state, "ct_other")
    assert calls[-1]["url"].endswith("/people/ct_other/fields")
    # A path can't be smuggled in.
    pf.read_person(state, "../fields")
    assert calls[-1]["url"].endswith("/people/..%2Ffields/fields")


def test_asks_for_a_person_page_when_there_is_none(monkeypatch):
    monkeypatch.setattr(pf, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    for out in (pf.read_person({"ctxToken": "tok"}, ""), pf.propose({"ctxToken": "tok", "personId": ""}, {"fld_1": 1}, "why", "")):
        assert out["status"] == "needs_person"
        assert "list of people" in out["message"]


def test_proposes_through_the_canvas_endpoint_and_relays_the_card(monkeypatch):
    card = {"kind": "person_fields", "title": "Field changes for this person"}
    calls = _capture(monkeypatch, body={"ok": True, "id": "aa_1", "url": f"/admin/crm/people/{PERSON}#vizzy", "card": card, "summary": "Saved as a suggestion."})
    out = pf.propose({"ctxToken": "tok", "personId": PERSON}, {"fld_1": 15}, "  Their team grew to 15.  ", "")
    assert calls[-1]["method"] == "POST" and calls[-1]["url"] == "https://app.example.com/api/agent/canvas"
    assert calls[-1]["payload"] == {
        "kind": "person_fields",
        "action": "save_draft",
        "scope": {"personId": PERSON},
        "changes": {"fld_1": 15},
        "why": "Their team grew to 15.",
    }
    assert out == {"status": "success", "suggestionId": "aa_1", "url": f"/admin/crm/people/{PERSON}#vizzy", "card": card, "message": "Saved as a suggestion."}


def test_needs_changes_before_it_calls(monkeypatch):
    monkeypatch.setattr(pf, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert pf.propose({"ctxToken": "tok", "personId": PERSON}, {}, "why")["status"] == "needs_changes"
    assert pf.propose({"ctxToken": "tok", "personId": PERSON}, None, "why")["status"] == "needs_changes"


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    monkeypatch.setattr(pf, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert pf.list_fields({})["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert pf.list_fields({"ctxToken": "tok"})["status"] == "unavailable"


def test_errors_become_plain_messages_and_switch_the_rules_off(monkeypatch):
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (401, {"error": "unauthorized"}, "unauthorized"),
        (403, {"error": "forbidden"}, "forbidden"),
        (404, {"error": "person_not_found"}, "person_not_found"),
        (400, {"error": "field_not_allowed", "issues": ["fld_1"]}, "field_not_allowed"),
        (400, {"error": "too_large"}, "too_large"),
        (400, {"error": "invalid_value", "issues": ["fld_1"]}, "invalid_value"),
        (409, {"error": "already_decided"}, "already_decided"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(pf, "_request", lambda *_a, s=status, b=body, **_k: (s, b if isinstance(b, str) else json.dumps(b)))
        monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
        state = {"ctxToken": "tok", "personId": PERSON, "personFieldsEnabled": True}
        out = pf.propose(state, {"fld_1": 1}, "why")
        assert out["status"] == "error" and out["code"] == code and out["message"]
        assert state["personFieldsEnabled"] is (code != "unavailable")
        if code == "too_large":
            assert out["message"].startswith("That suggestion is too big to save")
        if code == "invalid_value":
            assert "a text value marked cut can only be cleared with null" in out["message"]


def test_messages_name_no_area_and_use_no_dashes():
    for text in pf._ERRORS.values():
        assert "Audience" not in text
        assert "—" not in text and "–" not in text and " - " not in text
