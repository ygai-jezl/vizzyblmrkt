"""Unit tests for the Content Ops client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.sub_agents.content_ops.tools import content_client as cc


def test_intake_matches_the_wizard_shape():
    intake = cc.build_intake("Dinners", "newsletter_signups", "15-minute meals", spoke_channels=["linkedin"], topics=["audience"])
    assert intake == {
        "name": "Dinners",
        "strategy": {"objective": "newsletter_signups"},
        "scope": {"topics": ["audience"], "spark": "15-minute meals"},
        "knowledge": {},
        "topology": {"hubChannel": "newsletter", "spokeChannels": ["linkedin"]},
    }
    seq = cc.build_intake("Welcome", "email_sequence", "", sequence_type="welcome", hub_url="https://fernlight.test")
    assert seq["strategy"] == {"objective": "email_sequence", "hubUrl": "https://fernlight.test", "sequenceType": "welcome"}


def test_draft_uses_the_programme_in_view_and_relays_the_card(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    seen = {}
    card = {"kind": "content_plan", "id": "p1", "url": "/admin/workspace/ws1/create/p1"}

    def fake(method, url, token, payload=None):
        seen.update(method=method, url=url, token=token, payload=payload)
        return 200, json.dumps({"ok": True, "id": "p1", "status": "generating", "url": card["url"], "card": card, "summary": "Drafted"})

    monkeypatch.setattr(cc, "_request", fake)
    out = cc.draft_plan({"ctxToken": "tok", "workspaceId": "ws1"}, "", {"name": "x"}, "brief")
    assert out["status"] == "success" and out["card"] == card and out["planId"] == "p1"
    assert seen["url"] == "https://app.example.com/api/agent/canvas"
    assert seen["payload"]["kind"] == "content_plan" and seen["payload"]["mode"] == "create"
    assert seen["payload"]["scope"] == {"workspaceId": "ws1"}


def test_rewrite_needs_a_plan_and_pieces_and_explains_locked_pieces(monkeypatch):
    assert cc.rewrite_nodes({"ctxToken": "t", "workspaceId": "ws1"}, "", "", ["s1"], "shorter")["status"] == "needs_plan"
    assert cc.rewrite_nodes({"ctxToken": "t", "workspaceId": "ws1", "planId": "p1"}, "", "", [], "x")["status"] == "needs_nodes"
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    monkeypatch.setattr(
        cc, "_request", lambda *a, **k: (409, json.dumps({"error": "nodes_locked", "issues": ["s1: approve the hub first"]}))
    )
    out = cc.rewrite_nodes({"ctxToken": "t", "workspaceId": "ws1", "planId": "p1"}, "", "", ["s1"], "shorter")
    assert out["status"] == "error" and "approve the hub first" in out["message"]


def test_context_asks_about_the_programme_in_view(monkeypatch):
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    seen = {}

    def fake(method, url, token, payload=None):
        seen["url"] = url
        return 200, json.dumps({"programmes": [], "allowed": {}})

    monkeypatch.setattr(cc, "_request", fake)
    out = cc.get_context({"ctxToken": "t", "workspaceId": "weekly-plate"})
    assert out["status"] == "success"
    assert seen["url"].endswith("/api/agent/content/context?workspaceId=weekly-plate")


def test_unavailable_without_a_token_or_callback(monkeypatch):
    assert cc.get_context({})["status"] == "unavailable"
    monkeypatch.delenv("CANVAS_CALLBACK_URL", raising=False)
    assert cc.get_context({"ctxToken": "t"})["status"] == "unavailable"
