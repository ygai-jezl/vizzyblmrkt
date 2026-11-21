"""Unit tests for the new_person_propose client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import new_person_client as npc


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(url, token, payload):
        calls.append({"url": url, "token": token, "payload": payload})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(npc, "_post", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_fills_in_the_form_with_only_what_was_given_and_never_consent(monkeypatch):
    card = {"kind": "new_person", "title": "New person, filled in", "url": "/admin/crm?draft=aa_1"}
    calls = _capture(monkeypatch, body={"ok": True, "id": "aa_1", "status": "draft", "url": "/admin/crm?draft=aa_1", "card": card, "warnings": [], "summary": "Filled in."})
    out = npc.propose({"ctxToken": "tok"}, " sam@example.com ", "", "Sam", "", {"Plan": "Pro"})
    assert calls == [
        {
            "url": "https://app.example.com/api/agent/canvas",
            "token": "tok",
            "payload": {"kind": "new_person", "action": "save_draft", "email": "sam@example.com", "firstName": "Sam", "fields": {"Plan": "Pro"}},
        }
    ]
    assert "agreed" not in calls[0]["payload"] and "consent" not in calls[0]["payload"]
    assert out == {"status": "success", "draftId": "aa_1", "url": "/admin/crm?draft=aa_1", "card": card, "warnings": [], "message": "Filled in."}


def test_someone_already_in_people_links_to_their_page(monkeypatch):
    _capture(monkeypatch, body={"ok": True, "id": "ct_1", "status": "existing", "url": "/admin/crm/people/ct_1", "card": {"title": "Already in People"}, "summary": "Already there."})
    out = npc.propose({"ctxToken": "tok"}, "sam@example.com", "", "", "", None)
    assert out["status"] == "existing" and out["url"] == "/admin/crm/people/ct_1" and "draftId" not in out


def test_needs_an_email_or_a_phone_before_it_calls(monkeypatch):
    monkeypatch.setattr(npc, "_post", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    assert npc.propose({"ctxToken": "tok"}, "", "  ", "Sam", "", None)["status"] == "needs_contact"


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    monkeypatch.setattr(npc, "_post", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    assert npc.propose({}, "sam@example.com", "", "", "", None)["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert npc.propose({"ctxToken": "tok"}, "sam@example.com", "", "", "", None)["status"] == "unavailable"


def test_errors_become_plain_messages(monkeypatch):
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (403, {"error": "forbidden"}, "forbidden"),
        (400, {"error": "invalid_email"}, "invalid_email"),
        (400, {"error": "consent_not_allowed"}, "consent_not_allowed"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (400, {"error": "too_large"}, "too_large"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(npc, "_post", lambda *_, s=status, b=body: (s, b if isinstance(b, str) else json.dumps(b)))
        monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
        out = npc.propose({"ctxToken": "tok"}, "sam@example.com", "", "", "", None)
        assert out["status"] == "error" and out["code"] == code and out["message"]
        if code == "too_large":
            assert out["message"].startswith("That form is too big to save")


def test_root_never_records_consent_and_never_asks_for_more_details():
    assert "new_person_propose" in ROOT_SYSTEM_INSTRUCTION
    assert "You never record consent" in ROOT_SYSTEM_INSTRUCTION
    assert "Never ask for contact details the operator didn't offer" in ROOT_SYSTEM_INSTRUCTION
    assert "nobody is added until then" in ROOT_SYSTEM_INSTRUCTION
    assert "7 days at most" in ROOT_SYSTEM_INSTRUCTION
    for text in npc._ERRORS.values():
        assert "—" not in text and "–" not in text and " - " not in text
