"""Unit tests for the brand map tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import brand_map_client as bm

STATE = {"ctxToken": "tok"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None, timeout=bm._TIMEOUT_SECONDS):
        calls.append({"method": method, "url": url, "token": token, "payload": payload, "timeout": timeout})
        return status, body if isinstance(body, str) else json.dumps(body if body is not None else {})

    monkeypatch.setattr(bm, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_map_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"map": None, "note": "No brand map yet."})
    assert bm.get_map(STATE) == {"status": "success", "map": None, "note": "No brand map yet."}
    assert calls[0]["method"] == "GET" and calls[0]["url"] == "https://app.example.com/api/agent/brand-map"
    assert calls[0]["token"] == "tok"


def test_turns_what_the_operator_said_into_changes():
    changes, unread = bm.build_changes(
        category=" AI visibility tracking ",
        is_not=["A general SEO suite", " "],
        avoid=["GEO tool | AI visibility tracking", "rank tracker"],
        subjects=["Audits"],
        questions=["Audits | What does an audit check? | definition", "Share of voice | How is it measured?"],
        names=["Rivalco | alternative", "Acme Pulse | Use case"],
        aliases=["Acme Pulse | Pulse"],
    )
    assert unread == []
    assert changes == [
        {"type": "set_identity", "field": "category", "value": "AI visibility tracking"},
        {"type": "add_is_not", "text": "A general SEO suite"},
        {"type": "add_avoid", "term": "GEO tool", "useInstead": "AI visibility tracking"},
        {"type": "add_avoid", "term": "rank tracker"},
        {"type": "add_subject", "name": "Audits"},
        {"type": "add_question", "subject": "Audits", "text": "What does an audit check?", "intent": "definition"},
        {"type": "add_question", "subject": "Share of voice", "text": "How is it measured?"},
        {"type": "add_name", "name": "Rivalco", "kind": "alternative"},
        {"type": "add_name", "name": "Acme Pulse", "kind": "use_case"},
        {"type": "add_alias", "name": "Acme Pulse", "alias": "Pulse"},
    ]


def test_says_back_what_it_could_not_read_and_sends_nothing(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    out = bm.suggest(STATE, "add", "add these", questions=["How is it measured?"], names=["Rivalco | competitor"])
    assert out["status"] == "error" and out["code"] == "unread"
    assert len(out["issues"]) == 2 and calls == []
    assert bm.suggest(STATE, "add", "nothing")["code"] == "nothing_to_suggest"


def test_never_cuts_a_long_list_short_in_silence(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    out = bm.suggest(STATE, "add", "all our competitors", names=[f"Rival {i} | alternative" for i in range(25)])
    assert out["code"] == "too_many" and "25 changes" in out["message"] and calls == []


def test_files_suggestions_through_the_canvas_and_relays_the_card(monkeypatch):
    card = {"kind": "brand_map", "id": "brand_map", "cta": "Review and apply"}
    summary = "Filed 1 suggestion for your brand map: Add Rivalco as an alternative. Nothing in the map has changed."
    calls = _capture(monkeypatch, 200, {"ok": True, "url": "/admin/brand-kit/map", "card": card, "summary": summary, "warnings": []})
    out = bm.suggest(STATE, "add", "Rivalco is a competitor", names=["Rivalco | alternative"])
    assert out == {"status": "success", "url": "/admin/brand-kit/map", "warnings": [], "card": card, "message": summary}
    assert calls[0]["url"] == "https://app.example.com/api/agent/canvas"
    assert calls[0]["payload"] == {
        "kind": "brand_map",
        "action": "save_draft",
        "mode": "add",
        "brief": "Rivalco is a competitor",
        "changes": [{"type": "add_name", "name": "Rivalco", "kind": "alternative"}],
    }


def test_research_waits_longer_and_sends_no_changes(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True, "summary": "Research filed 4 suggestions"})
    out = bm.suggest(STATE, "research", "research my brand map", subjects=["ignored"])
    assert out["status"] == "success" and out["message"] == "Research filed 4 suggestions"
    assert calls[0]["payload"] == {"kind": "brand_map", "action": "save_draft", "mode": "research", "brief": "research my brand map"}
    assert calls[0]["timeout"] > bm._TIMEOUT_SECONDS


def test_relays_refusals_plainly(monkeypatch):
    _capture(monkeypatch, 400, {"error": "links_not_allowed", "issues": ["changes.0: Links are added by a person"]})
    out = bm.suggest(STATE, "add", "add our linkedin", subjects=["x"])
    assert out["code"] == "links_not_allowed" and "Brand › Brand map" in out["message"] and "changes.0" not in out["message"]
    _capture(monkeypatch, 403, {"error": "forbidden"})
    assert "Only an admin" in bm.suggest(STATE, "add", "x", subjects=["x"])["message"]
    _capture(monkeypatch, 503, {"error": "unavailable"})
    assert bm.get_map(STATE)["message"] == "The brand map isn't switched on in this environment yet."


def test_needs_the_link_to_the_app(monkeypatch):
    monkeypatch.delenv("CANVAS_CALLBACK_URL", raising=False)
    assert bm.get_map({})["code"] == "not_connected"


def test_root_routes_the_brand_map_and_never_claims_a_change():
    assert "`get_brand_map`" in ROOT_SYSTEM_INSTRUCTION and "`suggest_brand_map`" in ROOT_SYSTEM_INSTRUCTION
    assert "never say the map changed" in ROOT_SYSTEM_INSTRUCTION


def test_reads_a_large_map_a_part_at_a_time(monkeypatch):
    calls = _capture(monkeypatch, 200, {"subjects": []})
    bm.get_map(STATE, find="tracking AI answers")
    bm.get_map(STATE, subject_id="sub_aaaaaaaa")
    bm.get_map(STATE, import_id="latest")
    assert [c["url"] for c in calls] == [
        "https://app.example.com/api/agent/brand-map?find=tracking+AI+answers",
        "https://app.example.com/api/agent/brand-map?subject=sub_aaaaaaaa",
        "https://app.example.com/api/agent/brand-map?import=latest",
    ]


def test_proposes_buying_situations_and_links_questions_to_one(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True, "summary": "Filed 2 suggestions.", "card": {"kind": "brand_map"}})
    r = bm.suggest(
        STATE,
        "add",
        "From our chat",
        questions=["AI answers tracking | How do I report AI visibility to the board?"],
        situations=["Our clicks from Google are falling | Head of SEO | Win the clicks back", "The board asked what ChatGPT says about us"],
        situation_id="sit_aaaaaaaa",
    )
    assert r["status"] == "success"
    payload = calls[0]["payload"]
    assert payload["mode"] == "add" and payload["situationId"] == "sit_aaaaaaaa"
    assert payload["situations"] == [
        {"text": "Our clicks from Google are falling", "who": "Head of SEO", "want": "Win the clicks back"},
        {"text": "The board asked what ChatGPT says about us"},
    ]
    # Buying situations alone are enough to file.
    assert bm.suggest(STATE, "add", "x", situations=["We're launching a product"])["status"] == "success"


def test_researches_situations_and_one_situations_questions(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True, "summary": "Research proposed 3 buying situations."})
    bm.suggest(STATE, "situations", "Find them", customers="Two said their traffic fell", subjects=["ignored"])
    bm.suggest(STATE, "situation_questions", "What do they ask?", situation_id="sit_aaaaaaaa")
    assert calls[0]["payload"] == {"kind": "brand_map", "action": "save_draft", "mode": "situations", "brief": "Find them", "customers": "Two said their traffic fell"}
    assert calls[1]["payload"]["situationId"] == "sit_aaaaaaaa"
    assert calls[0]["timeout"] == bm._RESEARCH_TIMEOUT_SECONDS and calls[1]["timeout"] == bm._RESEARCH_TIMEOUT_SECONDS
    # Which situation to research is needed; nothing is sent without it.
    assert bm.suggest(STATE, "situation_questions", "x")["code"] == "no_situation_id"
    assert len(calls) == 2


def test_never_advises_a_set_number_of_subjects():
    from root_agent_pkg.tools import brand_map

    doc = brand_map.suggest_brand_map.__doc__ or ""
    assert "three to five" not in doc and "3 to 5" not in doc
    assert "no set number" in doc
