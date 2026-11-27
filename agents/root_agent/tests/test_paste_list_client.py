"""Unit tests for the paste_list_propose client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import paste_list_client as plc

# A made-up list: two people at .test and one firm with only its web address.
ROWS = "First Name,Email,Company Name,Website\nNia,nia@fernhill-plants.test,,\nJo,jo@example.test,,\n,,Northfield Ventures,northfield-ventures.test\nSam,,,\n"


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(url, token, payload):
        calls.append({"url": url, "token": token, "payload": payload})
        return status, json.dumps(body if body is not None else {})

    monkeypatch.setattr(plc, "_post", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def _no_call(monkeypatch):
    monkeypatch.setattr(plc, "_post", lambda *_: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")


def test_sends_the_rows_as_pasted_and_where_they_are_from_and_nothing_else(monkeypatch):
    card = {"kind": "paste_batch", "id": "aa_1", "title": "Pasted list, ready to add", "url": "/admin/crm?paste=aa_1"}
    left = [{"row": 5, "reason": "no_contact", "text": "Needs an email, a phone or a web address"}]
    counts = {"read": 4, "people": 2, "companies": 1, "left": 1, "already": 0}
    calls = _capture(
        monkeypatch,
        body={"ok": True, "status": "ready", "id": "aa_1", "url": "/admin/crm?paste=aa_1", "summary": "Read 4 rows.", "counts": counts, "leftOut": left, "card": card},
    )
    out = plc.propose({"ctxToken": "tok"}, ROWS, "  A local lenders list ")
    assert calls == [{"url": "https://app.example.com/api/agent/audience/paste", "token": "tok", "payload": {"text": ROWS, "source": "A local lenders list"}}]
    # Never consent, never a brand: the app takes the brand from the token.
    assert set(calls[0]["payload"]) == {"text", "source"}
    assert out == {"status": "ready", "batchId": "aa_1", "url": "/admin/crm?paste=aa_1", "card": card, "counts": counts, "leftOut": left, "message": "Read 4 rows."}


def test_nothing_to_add_relays_the_rows_left_out(monkeypatch):
    left = [{"row": 2, "reason": "in_people", "text": "Already in People"}]
    _capture(monkeypatch, body={"ok": True, "status": "nothing_to_add", "summary": "Nothing to add: every row is already here or was left out.", "leftOut": left})
    out = plc.propose({"ctxToken": "tok"}, ROWS, "An event")
    assert out == {"status": "nothing_to_add", "leftOut": left, "message": "Nothing to add: every row is already here or was left out."}


def test_asks_for_the_rows_and_where_they_are_from_before_it_calls(monkeypatch):
    _no_call(monkeypatch)
    assert plc.propose({"ctxToken": "tok"}, "  \n ", "An event")["status"] == "needs_rows"
    out = plc.propose({"ctxToken": "tok"}, ROWS, "  ")
    assert out["status"] == "needs_source" and "where this list is from" in out["message"]


def test_too_much_text_never_reaches_the_app(monkeypatch):
    _no_call(monkeypatch)
    out = plc.propose({"ctxToken": "tok"}, "Email\n" + "x" * plc.MAX_TEXT_CHARS, "An event")
    assert out == {"status": "error", "code": "too_long", "message": "That's too much text to read at once. Paste fewer rows or columns."}


def test_the_body_keeps_accents_and_other_scripts_as_utf8():
    body = plc.encode_payload(plc.build_payload("Name,Email\nZoë Example,zoe@example.test\n漢字,kanji@example.test", "Café list"))
    assert "Zoë".encode("utf-8") in body and "漢字".encode("utf-8") in body
    assert b"\\u" not in body
    assert json.loads(body.decode("utf-8"))["source"] == "Café list"


def test_unavailable_without_a_token_or_a_callback_url(monkeypatch):
    _no_call(monkeypatch)
    assert plc.propose({}, ROWS, "An event")["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    assert plc.propose({"ctxToken": "tok"}, ROWS, "An event")["status"] == "unavailable"


def test_relays_the_apps_own_words_for_a_paste_code(monkeypatch):
    message = "That's more than 50 rows. Paste up to 50 at a time."
    _capture(monkeypatch, status=400, body={"ok": False, "error": "too_many_rows", "message": message})
    assert plc.propose({"ctxToken": "tok"}, ROWS, "An event") == {"status": "error", "code": "too_many_rows", "message": message}


def test_gate_answers_become_its_own_plain_words(monkeypatch):
    for status, body, code in [
        (503, {"error": "unavailable"}, "unavailable"),
        (503, {"error": "chat_unavailable"}, "chat_unavailable"),
        (503, {"error": "canvas_auth_unconfigured"}, "canvas_auth_unconfigured"),
        (401, {"error": "unauthorized"}, "unauthorized"),
        (403, {"error": "forbidden"}, "forbidden"),
        (429, {"error": "rate_limited"}, "rate_limited"),
        (400, {"ok": False, "error": "consent_not_allowed", "message": "Nobody can be added as agreeing."}, "consent_not_allowed"),
        (500, "not json", "http_500"),
    ]:
        monkeypatch.setattr(plc, "_post", lambda *_, s=status, b=body: (s, b if isinstance(b, str) else json.dumps(b)))
        monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
        out = plc.propose({"ctxToken": "tok"}, ROWS, "An event")
        assert out["status"] == "error" and out["code"] == code and out["message"]
        if code in plc._ERRORS:
            assert out["message"] == plc._ERRORS[code]
    # Off here: no box to point to. Only the chat off: the box on People works.
    assert plc._ERRORS["unavailable"] == "Pasting a list isn't switched on here."
    assert "People" not in plc._ERRORS["unavailable"]
    assert plc._ERRORS["chat_unavailable"] == "Pasting a list into chat isn't switched on here. Use Paste a list on People instead."
    assert plc._ERRORS["forbidden"] == "Only an admin on the team can add a list, so I can't read it into a card for you."


def test_root_reads_pasted_lists_through_the_app_and_never_records_consent():
    assert "paste_list_propose" in ROOT_SYSTEM_INSTRUCTION
    assert "add a pasted list" in ROOT_SYSTEM_INSTRUCTION
    assert "you never record consent" in ROOT_SYSTEM_INSTRUCTION
    assert "Never type out, complete or invent a list yourself" in ROOT_SYSTEM_INSTRUCTION
    # The static prompt names no public list: where to find one comes from the paste-a-list help
    # page, which is served only while Paste a list is switched on.
    assert "Fundraising Kit" not in ROOT_SYSTEM_INSTRUCTION and "VC Corner" not in ROOT_SYSTEM_INSTRUCTION
    assert "call `read_help_page` with `paste-a-list`" in ROOT_SYSTEM_INSTRUCTION
    # Its public lists are investor directories: no lender or grant list is named from them, and a
    # setup guide that is off is not mistaken for pasting being off.
    assert "investor directories only: for lenders, grant bodies or stockists, say it has no list for those" in ROOT_SYSTEM_INSTRUCTION
    assert "if it says the setup guide isn't available, say you can't open that help page here" in ROOT_SYSTEM_INSTRUCTION
    # The pasted list line comes right after the add a person line.
    assert ROOT_SYSTEM_INSTRUCTION.index("To **add a pasted list**") > ROOT_SYSTEM_INSTRUCTION.index("To **add a person**")
    for text in [*plc._ERRORS.values(), plc._TOO_LONG]:
        assert "—" not in text and "–" not in text and " - " not in text
