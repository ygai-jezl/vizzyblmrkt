"""Unit tests for the draft_invite_wave client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.sub_agents.campaign_ops.tools import canvas_client as cc


def test_payload_leaves_defaults_to_the_server_and_clamps():
    assert cc.build_invite_wave_payload("beta", "short and warm") == {
        "kind": "invite_wave",
        "action": "save_draft",
        "scope": {"campaignId": "beta"},
        "brief": "short and warm",
    }
    p = cc.build_invite_wave_payload("beta", "", size=5000, expires_in_days=3, wave_id="wav_1")
    assert p["size"] == 1000
    assert p["expiresInDays"] == 7
    assert p["scope"] == {"campaignId": "beta", "waveId": "wav_1"}


def test_success_relays_the_card():
    card = {"kind": "invite_wave", "id": "wav_1", "url": "/admin/launches/beta/invites?wave=wav_1"}
    out = cc.parse_invite_wave_response(
        200, json.dumps({"ok": True, "id": "wav_1", "summary": "Drafted", "url": card["url"], "card": card})
    )
    assert out == {"status": "success", "waveId": "wav_1", "message": "Drafted", "url": card["url"], "card": card}


def test_locked_launch_says_what_to_do_first():
    out = cc.parse_invite_wave_response(
        409, json.dumps({"error": "invites_locked", "issues": ["Connect your product first."]})
    )
    assert out["status"] == "error"
    assert "Connect your product first." in out["message"]
    assert "sent" not in out["message"].lower()


def test_needs_a_token_a_launch_and_a_callback(monkeypatch):
    assert cc.draft_invite_wave_via_canvas({}, "beta", "")["status"] == "unavailable"
    assert cc.draft_invite_wave_via_canvas({"ctxToken": "t"}, "", "")["status"] == "needs_campaign"
    monkeypatch.delenv("CANVAS_CALLBACK_URL", raising=False)
    assert cc.draft_invite_wave_via_canvas({"ctxToken": "t", "campaignId": "beta"}, "", "")["status"] == "unavailable"


def test_happy_path_uses_the_launch_in_view(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    captured = {}

    def fake_post(url, payload, token):
        captured.update(url=url, payload=payload, token=token)
        return 200, json.dumps({"ok": True, "id": "wav_9", "summary": "ok"})

    monkeypatch.setattr(cc, "_post_canvas", fake_post)
    out = cc.draft_invite_wave_via_canvas({"ctxToken": "tok", "campaignId": "beta"}, "", "invite them", size=100)
    assert out["status"] == "success"
    assert captured["url"] == "https://app.example.com/api/agent/canvas"
    assert captured["payload"]["scope"] == {"campaignId": "beta"}
    assert captured["payload"]["size"] == 100
