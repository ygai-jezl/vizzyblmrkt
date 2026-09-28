"""Unit tests for the journey style tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import asyncio
import json
import types

from root_agent_pkg.callbacks.context_envelope import apply_context_envelope
from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.sub_agents.lifecycle_ops.instruction_builder import build_lifecycle_ops_instruction
from root_agent_pkg.sub_agents.lifecycle_ops.tools import lifecycle_client as lc
from root_agent_pkg.tools import journey_style_client as js

# What the journey_style kind takes (it refuses any other key).
KIND_KEYS = {
    "kind",
    "action",
    "journeyId",
    "campaignId",
    "mode",
    "headerColor",
    "buttonColor",
    "headerGradientColor",
    "headerText",
}
OFF = (
    "Journey styles aren't switched on in this environment yet, so every journey wears the brand's "
    "Email style. I can suggest a change to that instead, for an admin to review in Brand › Email style."
)


def _state(**extra):
    return {"ctxToken": "tok", "journeyId": "lcj_page", **extra}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, body if isinstance(body, str) else json.dumps(body if body is not None else {})

    monkeypatch.setattr(js, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_page_journey_with_the_session_token(monkeypatch):
    read = {"journey": {"id": "lcj_page", "name": "Onboarding"}, "canEdit": True, "draft": {"mode": "brand"}}
    calls = _capture(monkeypatch, 200, read)
    state = _state()
    assert js.get_style(state) == {"status": "success", **read}
    assert calls == [
        {
            "method": "GET",
            "url": "https://app.example.com/api/agent/journey-style?journeyId=lcj_page",
            "token": "tok",
            "payload": None,
        }
    ]
    assert state["journeyStyleEnabled"] is True


def test_the_journey_is_the_one_named_then_the_page_then_the_launch_in_view(monkeypatch):
    calls = _capture(monkeypatch, 200, {})
    js.get_style({"ctxToken": "tok", "campaignId": "cmp_1"})
    js.get_style(_state(campaignId="cmp_1"))
    js.get_style(_state(campaignId="cmp_1"), journey_id=" lcj_other ")
    js.get_style(_state(), campaign_id="cmp_2")
    js.get_style(_state(), journey_id="lcj_other", campaign_id="cmp_2")
    assert [c["url"].split("?", 1)[1] for c in calls] == [
        "campaignId=cmp_1",
        "journeyId=lcj_page",
        "journeyId=lcj_other",
        "campaignId=cmp_2",
        "journeyId=lcj_other",
    ]
    assert js.journey_ref({"journeyId": "  ", "campaignId": "cmp_1"}) == {"campaignId": "cmp_1"}


def test_ids_are_query_encoded(monkeypatch):
    calls = _capture(monkeypatch, 200, {})
    js.get_style({"ctxToken": "tok"}, journey_id="a&b=c")
    assert calls[0]["url"].endswith("/api/agent/journey-style?journeyId=a%26b%3Dc")


def test_no_journey_asks_which_without_calling_the_app(monkeypatch):
    monkeypatch.setattr(js, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    for out in (js.get_style({"ctxToken": "tok"}), js.set_style({"ctxToken": "tok"}, "custom", "#1b2a4a")):
        assert out["status"] == "needs_journey"
        assert "Which journey" in out["message"]


def _turn(state, envelope):
    """One message through the real envelope callback, the way the app's chat route prefixes it."""
    text = f"[ctx:{json.dumps(envelope)}] make this launch's welcome emails navy"
    part = types.SimpleNamespace(text=text)
    request = types.SimpleNamespace(contents=[types.SimpleNamespace(role="user", parts=[part])])
    asyncio.run(apply_context_envelope(types.SimpleNamespace(state=state), request))
    assert part.text == "make this launch's welcome emails navy"


def test_the_panel_moving_from_a_journey_page_to_a_launch_page_styles_the_launchs_journey(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    graphs = []

    def save(method, url, token, payload=None):
        graphs.append(payload)
        return 200, "{}"

    monkeypatch.setattr(lc, "_request", save)
    # One Ask Vizzy conversation: a journey's page, then a launch's, where the app sends an empty
    # journeyId (the shared chat's "no journey in view any more").
    state = {}
    _turn(state, {"tenantId": "ten_A", "ctxToken": "tok", "page": "Journeys › A", "journeyId": "lcj_a"})
    assert js.journey_ref(state) == {"journeyId": "lcj_a"}
    _turn(state, {"tenantId": "ten_A", "ctxToken": "tok", "page": "Launches › B", "campaignId": "cmp_b", "journeyId": ""})
    assert js.journey_ref(state) == {"campaignId": "cmp_b"}
    js.set_style(state, "custom", header_color="#1b2a4a")
    assert calls[0]["payload"]["campaignId"] == "cmp_b"
    assert "journeyId" not in calls[0]["payload"]
    # Nor is lcj_a still "the page the operator is on" for Lifecycle Ops, or the draft a new graph saves over.
    assert "lcj_a" not in build_lifecycle_ops_instruction(types.SimpleNamespace(state=state))
    lc.save_graph(state, "pcn_1", None, {"nodes": [], "edges": []}, None, None, "", None)
    assert graphs[0]["scope"] == {"connectionId": "pcn_1", "journeyId": None}


def test_the_panel_moving_from_a_launch_page_to_home_names_no_journey(monkeypatch):
    monkeypatch.setattr(js, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    # Off a launch page the app sends an empty campaignId too, so B's welcome journey isn't "this journey" on Home.
    state = {}
    _turn(state, {"tenantId": "ten_A", "ctxToken": "tok", "page": "Launches › B", "campaignId": "cmp_b", "journeyId": ""})
    assert js.journey_ref(state) == {"campaignId": "cmp_b"}
    _turn(state, {"tenantId": "ten_A", "ctxToken": "tok", "page": "Home", "campaignId": "", "journeyId": ""})
    assert js.journey_ref(state) is None
    assert js.set_style(state, "custom", header_color="#1b2a4a")["status"] == "needs_journey"


def test_set_sends_the_journey_and_only_the_fields_given(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    js.set_style(_state(), "Custom", header_color=" #1B2A4A ")
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "https://app.example.com/api/agent/canvas"
    assert calls[0]["token"] == "tok"
    assert calls[0]["payload"] == {
        "kind": "journey_style",
        "action": "save_draft",
        "journeyId": "lcj_page",
        "mode": "custom",
        "headerColor": "#1B2A4A",
    }
    full = js.build_set_payload(
        "custom", {"campaignId": "cmp_1"}, "#1b2a4a", "#ff6b35", "#4f46e5", header_text_color=" White "
    )
    assert full == {
        "kind": "journey_style",
        "action": "save_draft",
        "campaignId": "cmp_1",
        "mode": "custom",
        "headerColor": "#1b2a4a",
        "buttonColor": "#ff6b35",
        "headerGradientColor": "#4f46e5",
        "headerText": "white",
    }
    assert set(full) <= KIND_KEYS


def test_brand_sends_the_mode_alone():
    assert js.build_set_payload("brand", {"journeyId": "lcj_1"}) == {
        "kind": "journey_style",
        "action": "save_draft",
        "journeyId": "lcj_1",
        "mode": "brand",
    }


def test_solid_header_sends_null_and_wins_over_a_colour_2():
    p = js.build_set_payload("custom", {"journeyId": "lcj_1"}, header_gradient_color="#4f46e5", solid_header=True)
    assert "headerGradientColor" in p and p["headerGradientColor"] is None


def test_blank_fields_send_nothing():
    p = js.build_set_payload("custom", {"journeyId": "lcj_1"}, "  ", " ", "", header_text_color=" ")
    assert set(p) == {"kind", "action", "journeyId", "mode"}


def test_success_relays_the_card_and_the_journey(monkeypatch):
    card = {
        "kind": "journey_style",
        "id": "lcj_page",
        "title": "Onboarding",
        "subtitle": "Email style",
        "url": "/admin/lifecycle/lcj_page",
        "stats": [{"label": "header", "value": "#1b2a4a"}, {"label": "button", "value": "#ff6b35"}],
        "warnings": 0,
        "note": "Saved to the draft — publish the journey to apply it.",
        "cta": "Open journey",
    }
    _capture(
        monkeypatch,
        200,
        {
            "ok": True,
            "kind": "journey_style",
            "id": "lcj_page",
            "journeyId": "lcj_page",
            "status": "active",
            "url": card["url"],
            "warnings": [],
            "summary": 'I set "Onboarding" to its own email style in its draft.',
            "card": card,
        },
    )
    state = _state()
    out = js.set_style(state, "custom", "#1b2a4a", "#ff6b35")
    assert out == {
        "status": "success",
        "journeyId": "lcj_page",
        "url": card["url"],
        "warnings": [],
        "card": card,
        "message": 'I set "Onboarding" to its own email style in its draft.',
    }
    assert state["journeyStyleEnabled"] is True


def test_no_token_or_callback_says_it_cant_reach_the_app(monkeypatch):
    monkeypatch.setattr(js, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    outs = [js.get_style({"journeyId": "lcj_1"}), js.set_style({"journeyId": "lcj_1"}, "brand")]
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    outs += [js.get_style(_state()), js.set_style(_state(), "brand")]
    for out in outs:
        assert out["status"] == "error"
        assert "can't reach the app" in out["message"]
        assert "switched on" not in out["message"]


def test_errors_become_plain_messages(monkeypatch):
    for status, body, code, says in [
        (503, {"error": "unavailable"}, "unavailable", OFF),
        (400, {"error": "unknown_kind", "known": ["email_style"]}, "unknown_kind", OFF),
        (404, "<html>Not found</html>", "http_404", OFF),
        (403, {"error": "forbidden"}, "forbidden", "Only an admin can set a journey's email style"),
        (401, {"error": "unauthorized", "reason": "expired"}, "unauthorized", "session to the app expired"),
        (429, {"error": "rate_limited"}, "rate_limited", "try again in a few minutes"),
        (400, {"error": "invalid_input", "issues": ["headerColor: Invalid"]}, "invalid_input", "headerColor: Invalid"),
        (404, {"error": "journey_not_found"}, "journey_not_found", "couldn't find that journey"),
        (404, {"error": "launch_not_found"}, "launch_not_found", "couldn't find that launch"),
        (0, {"error": "network_error", "detail": "timed out"}, "network_error", "couldn't reach the app"),
        (500, "not json", "http_500", "Please try again"),
    ]:
        _capture(monkeypatch, status, body)
        for out in (js.get_style(_state()), js.set_style(_state(), "custom", "#1b2a4a")):
            assert out["status"] == "error" and out["code"] == code
            assert says in out["message"]
            # Only journey styles being off (or the app predating them) says "switched on".
            assert ("switched on" in out["message"]) == (says == OFF)


def test_switched_off_offers_the_brand_style_instead(monkeypatch):
    _capture(monkeypatch, 503, {"error": "unavailable"})
    out = js.set_style(_state(), "custom", "#000080")
    assert out["message"] == OFF
    assert "brand's Email style" in out["message"] and "suggest" in out["message"]


def test_the_state_flag_follows_what_the_app_says(monkeypatch):
    state = _state(journeyStyleEnabled=True)
    _capture(monkeypatch, 503, {"error": "unavailable"})
    js.get_style(state)
    assert state["journeyStyleEnabled"] is False
    _capture(monkeypatch, 200, {"ok": True})
    js.set_style(state, "brand")
    assert state["journeyStyleEnabled"] is True
    _capture(monkeypatch, 404, "<html>Not found</html>")
    js.set_style(state, "brand")
    assert state["journeyStyleEnabled"] is False
    # Any other answer says nothing about the flag.
    for status, body in [
        (401, {"error": "unauthorized"}),
        (403, {"error": "forbidden"}),
        (404, {"error": "journey_not_found"}),
        (0, {"error": "network_error"}),
        (200, {"ok": False}),
    ]:
        for was in (True, False):
            state["journeyStyleEnabled"] = was
            _capture(monkeypatch, status, body)
            js.set_style(state, "brand")
            if status != 200:
                js.get_style(state)
            assert state["journeyStyleEnabled"] is was


def test_a_journey_not_found_carries_the_apps_reason(monkeypatch):
    note = (
        "This launch's welcome emails haven't moved to the new journey engine, so they wear the brand's "
        "Email style (Brand › Email style)."
    )
    _capture(monkeypatch, 404, {"error": "journey_not_found", "issues": [note]})
    out = js.get_style({"ctxToken": "tok", "campaignId": "cmp_1"})
    assert out["message"] == f"I couldn't find that journey in this account, or it's archived. {note}"


def test_header_options_switched_off_says_so_once(monkeypatch):
    issue = "headerGradientColor/headerText: gradient headers and header text colour aren't switched on here yet"
    _capture(monkeypatch, 400, {"error": "header_options_unavailable", "issues": [issue]})
    out = js.set_style(_state(), "custom", header_gradient_color="#4f46e5")
    assert out == {
        "status": "error",
        "code": "header_options_unavailable",
        "issues": [issue],
        "message": "Gradient headers and header text colour aren't switched on in this environment yet.",
    }


def test_root_routes_a_journeys_look_to_the_tools_with_the_brand_fallback():
    lines = ROOT_SYSTEM_INSTRUCTION.splitlines()
    bullet = next(line for line in lines if "**one journey's own look**" in line)
    # After the brand's Email style bullet, before Lifecycle Ops.
    at = lines.index(bullet)
    assert "**Email style**" in lines[at - 1]
    assert "`lifecycle_ops_agent`" in lines[at + 1]
    tools = bullet.index("call `get_journey_email_style`, then `set_journey_email_style`")
    draft = bullet.index("It saves the journey's draft only")
    off = bullet.index("If a tool says journey styles aren't switched on")
    fallback = bullet.index("offer a brand Email style suggestion instead (`get_email_style`, then `suggest_email_style`)")
    assert tools < draft < off < fallback
    for words in ("give this journey a navy header", "make this launch's welcome emails navy", 'mode "custom"', '"brand"'):
        assert words in bullet
    assert "never that it's live" in bullet
