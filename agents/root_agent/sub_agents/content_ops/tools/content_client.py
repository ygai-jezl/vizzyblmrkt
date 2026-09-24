"""Pure, ADK-free client logic for the Content Ops tools.

Lives apart from content_tools.py (which imports ADK's ToolContext at runtime) so
the request/response logic stays unit-testable without ADK. The only side effect
— the HTTP call — is isolated in `_request` so tests can monkeypatch it.

Every call carries the signed capability token (`ctxToken` in session state) as
`X-Canvas-Context`; the app takes the tenant from that token, never from here.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

CANVAS_PATH = "/api/agent/canvas"
CONTEXT_PATH = "/api/agent/content/context"
PLAN_PATH = "/api/agent/content/plans/"
_TIMEOUT_SECONDS = 120  # an architect call plus the hub copy


def _request(method: str, url: str, token: str, payload: "dict | None" = None) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"X-Canvas-Context": token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def _base_and_token(state: "dict | None") -> "tuple[str, str] | dict":
    token = (state or {}).get("ctxToken")
    if not token:
        return {"status": "unavailable", "message": "Drafting content isn't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Drafting content isn't configured (no callback URL)."}
    return base, token


def _json(body_text: str) -> dict:
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    return body if isinstance(body, dict) else {}


_ERRORS = {
    "unavailable": "Drafting content plans from chat isn't switched on in this environment.",
    "workspace_not_found": "I couldn't find that content programme in this account.",
    "plan_not_found": "I couldn't find that plan in this programme.",
    "invalid_intake": "Some of the plan details weren't valid",
    "invalid_input": "The request was missing something",
    "ebook_in_studio": "eBooks are written in the eBook studio, not from chat",
    "nodes_locked": "I can't rewrite some of those pieces",
    "rate_limited": "I've drafted several plans just now. Please try again in a few minutes.",
    "canvas_auth_unconfigured": "Drafting from chat isn't enabled in this environment yet.",
    "unauthorized": "My session to the app expired. Please send your message again.",
}


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    issues = body.get("issues") or []
    base = _ERRORS.get(code, "I couldn't do that just now. Please try again.")
    detail = "; ".join(str(i) for i in issues[:8])
    return {
        "status": "error",
        "code": code,
        "issues": issues[:20],
        "message": f"{base}: {detail}" if detail else base,
    }


def parse_author_response(status_code: int, body_text: str) -> dict:
    """Normalise the canvas endpoint's answer into a tool result (the card rides along)."""
    body = _json(body_text)
    if 200 <= status_code < 300 and body.get("ok"):
        return {
            "status": "success",
            "planId": body.get("id"),
            "planStatus": body.get("status"),
            "url": body.get("url"),
            "warnings": body.get("warnings", []),
            "card": body.get("card"),
            "message": body.get("summary") or "Saved the plan as a draft.",
        }
    return error_result(status_code, body)


def build_intake(
    name: str,
    objective: str,
    spark: str,
    hub_channel: str = "newsletter",
    spoke_channels: "list | None" = None,
    topics: "list | None" = None,
    hub_url: str = "",
    sequence_type: str = "",
) -> dict:
    """The same intake the Create wizard sends (the server validates and normalises it)."""
    strategy: dict = {"objective": objective}
    if hub_url:
        strategy["hubUrl"] = hub_url
    if sequence_type:
        strategy["sequenceType"] = sequence_type
    return {
        "name": name,
        "strategy": strategy,
        "scope": {"topics": list(topics or [])[:26], "spark": spark or ""},
        "knowledge": {},
        "topology": {"hubChannel": hub_channel or "newsletter", "spokeChannels": list(spoke_channels or [])[:8]},
    }


def _workspace(state: "dict | None", workspace_id: str) -> "str | None":
    return workspace_id or (state or {}).get("workspaceId") or None


def get_context(state: "dict | None") -> dict:
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    in_view = (state or {}).get("workspaceId")
    query = f"?workspaceId={urllib.parse.quote(in_view, safe='')}" if in_view else ""
    status_code, body_text = _request("GET", base + CONTEXT_PATH + query, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def get_plan(state: "dict | None", workspace_id: str, plan_id: str) -> dict:
    ws = _workspace(state, workspace_id)
    plan = plan_id or (state or {}).get("planId")
    if not ws or not plan:
        return {"status": "needs_plan", "message": "Which programme and plan should I open?"}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    url = base + PLAN_PATH + urllib.parse.quote(ws, safe="") + "/" + urllib.parse.quote(plan, safe="")
    status_code, body_text = _request("GET", url, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def draft_plan(state: "dict | None", workspace_id: str, intake: dict, brief: str) -> dict:
    ws = _workspace(state, workspace_id)
    if not ws:
        return {"status": "needs_workspace", "message": "Which content programme is this plan for?"}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = {
        "kind": "content_plan",
        "action": "save_draft",
        "mode": "create",
        "scope": {"workspaceId": ws},
        "intake": intake,
        "brief": brief or "",
    }
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_author_response(status_code, body_text)


def rewrite_nodes(state: "dict | None", workspace_id: str, plan_id: str, node_ids: list, instructions: str) -> dict:
    ws = _workspace(state, workspace_id)
    plan = plan_id or (state or {}).get("planId")
    if not ws or not plan:
        return {"status": "needs_plan", "message": "Which plan should I change?"}
    if not node_ids:
        return {"status": "needs_nodes", "message": "Which pieces should I rewrite?"}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = {
        "kind": "content_plan",
        "action": "save_draft",
        "mode": "refill",
        "scope": {"workspaceId": ws, "planId": plan},
        "nodeIds": list(node_ids)[:20],
        "instructions": (instructions or "")[:1500],
        "brief": instructions or "",
    }
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_author_response(status_code, body_text)
