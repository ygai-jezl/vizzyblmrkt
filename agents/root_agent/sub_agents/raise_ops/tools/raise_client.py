"""Pure, ADK-free client logic for the Raise Ops tools.

Lives apart from raise_tools.py (which imports ADK's ToolContext at runtime) so the request and
response logic stays unit-testable without ADK. The only side effect, the HTTP call, is isolated in
`_request` so tests can monkeypatch it.

Every call carries the signed capability token (`ctxToken` in session state) as `X-Canvas-Context`;
the app takes the brand from that token, never from here. Drafting and changing go through the
canvas endpoint, which only ever saves a draft version; reading has its own route.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

CANVAS_PATH = "/api/agent/canvas"
DOCS_PATH = "/api/agent/raise/docs"
_TIMEOUT_SECONDS = 150  # one model call plus the context pack

AUDIENCES = ("investor", "lender")
STAGES = ("pre_seed", "seed")
CHANGES = ("rewrite", "notes", "add", "remove", "move", "layout", "number", "typed_number", "refresh_numbers")


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
        return {"status": "unavailable", "message": "Decks from chat aren't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Decks from chat aren't set up in this environment yet."}
    return base, token


def _json(body_text: str) -> dict:
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    return body if isinstance(body, dict) else {}


_SWITCHED_OFF = "Decks from chat aren't switched on in this environment yet."
_ERRORS = {
    "unavailable": _SWITCHED_OFF,
    "http_404": _SWITCHED_OFF,
    "not_included": "The Raise kit isn't included in this brand's plan.",
    "forbidden": "Only an admin can make or change a deck.",
    "doc_not_found": "I couldn't find that deck. Ask me to list your decks.",
    "stale_version": "Someone saved a newer version of this deck. I'll read it again before changing it.",
    "deck_limit": "This brand has 20 decks, the most it can keep. Delete one to make another.",
    "rate_limited": "I've drafted several decks just now. Please try again in a few minutes.",
    "invalid_ops": "Some of that change wasn't valid",
    "invalid_input": "The request was missing something",
    "quote_mismatch": "That number isn't in what the person said. Ask them for it and pass their own words.",
    "canvas_auth_unconfigured": "Decks from chat aren't set up in this environment yet.",
    "unauthorized": "My session to the app expired. Please send your message again.",
}


def error_result(status_code: int, body: dict) -> dict:
    # A 404 that names no error is a copy without these routes (http_404), not a missing deck.
    code = body.get("error") or f"http_{status_code}"
    issues = body.get("issues") or []
    if not isinstance(issues, list):
        issues = []
    base = _ERRORS.get(code, "I couldn't do that just now. Please try again.")
    detail = "; ".join(str(i) for i in issues[:8])
    return {
        "status": "error",
        "code": code,
        "issues": issues[:20],
        "message": f"{base}: {detail}" if detail else base,
    }


def _version_of(card: object) -> "int | None":
    if not isinstance(card, dict):
        return None
    for stat in card.get("stats") or []:
        if isinstance(stat, dict) and stat.get("label") == "version" and isinstance(stat.get("value"), int):
            return stat["value"]
    return None


def parse_author_response(status_code: int, body_text: str) -> dict:
    """The canvas endpoint's answer as a tool result: the card rides along for the chat to show."""
    body = _json(body_text)
    if 200 <= status_code < 300 and body.get("ok"):
        card = body.get("card")
        return {
            "status": "success",
            "docId": body.get("id"),
            "version": _version_of(card),
            "url": body.get("url"),
            "card": card,
            "warnings": body.get("warnings", []),
            "message": body.get("summary") or "Saved the deck as a draft.",
        }
    return error_result(status_code, body)


def _norm(value: str) -> str:
    """Lower case, words joined by underscores: "Pre-seed" and "pre seed" both become pre_seed."""
    return "_".join((value or "").strip().lower().replace("-", " ").split())


def _doc_id(state: "dict | None", doc_id: str) -> str:
    return (doc_id or "").strip() or str((state or {}).get("raiseDocId") or "")


def draft(state: "dict | None", audience: str, stage: str = "", title: str = "", brief: str = "") -> dict:
    who = _norm(audience)
    if who not in AUDIENCES:
        return {"status": "needs_audience", "message": "Is this a deck for investors, or a pack for a lender such as a bank?"}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload: dict = {"kind": "raise_deck", "action": "save_draft", "mode": "draft", "audience": who}
    step = _norm(stage)
    if who == "investor" and step in STAGES:
        payload["stage"] = step
    if (title or "").strip():
        payload["title"] = title.strip()[:80]
    if (brief or "").strip():
        payload["brief"] = brief.strip()[:1500]
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_author_response(status_code, body_text)


def get(state: "dict | None", doc_id: str = "") -> dict:
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    wanted = _doc_id(state, doc_id)
    query = f"?docId={urllib.parse.quote(wanted, safe='')}" if wanted else ""
    status_code, body_text = _request("GET", base + DOCS_PATH + query, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def build_op(
    change: str,
    slide: int = 0,
    after: int = 0,
    to: int = 0,
    ask: str = "",
    section: str = "",
    layout: str = "",
    meaning: str = "",
    weeks: int = 0,
    launch: str = "",
    name: str = "",
    value: float = 0,
    unit: str = "",
    currency: str = "",
    per: str = "",
    source_note: str = "",
    quote: str = "",
) -> "dict | None":
    """One change for the canvas endpoint, with only the fields it takes (empty ones dropped)."""
    kind = _norm(change)
    if kind not in CHANGES:
        return None
    op: dict = {"change": kind}

    def text(key: str, val: str, limit: int) -> None:
        if (val or "").strip():
            op[key] = val.strip()[:limit]

    if kind in ("rewrite", "notes"):
        op["slide"] = int(slide)
        text("ask", ask, 600)
    elif kind == "add":
        op["after"] = max(0, int(after))
        op["section"] = _norm(section)
        if layout:
            op["layout"] = _norm(layout)
        text("ask", ask, 600)
    elif kind == "remove":
        op["slide"] = int(slide)
    elif kind == "move":
        op["slide"] = int(slide)
        op["to"] = int(to)
    elif kind == "layout":
        op["slide"] = int(slide)
        op["layout"] = _norm(layout)
    elif kind == "number":
        op["slide"] = int(slide)
        op["meaning"] = (meaning or "").strip()
        if int(weeks or 0) in (4, 8, 12):
            op["weeks"] = int(weeks)
        text("launch", launch, 80)
    elif kind == "typed_number":
        op["slide"] = int(slide)
        text("name", name, 60)
        op["value"] = value
        op["unit"] = _norm(unit)
        if (currency or "").strip():
            op["currency"] = currency.strip().upper()
        if _norm(per) in ("month", "year"):
            op["per"] = _norm(per)
        text("from", source_note, 60)
        text("quote", quote, 200)
    return op


def revise(state: "dict | None", op: "dict | None", note: str = "", version: int = 0, doc_id: str = "") -> dict:
    if op is None:
        return {
            "status": "error",
            "code": "invalid_change",
            "message": "That change isn't one I can make. Use rewrite, notes, add, remove, move, layout, number, typed_number or refresh_numbers.",
        }
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload: dict = {"kind": "raise_deck", "action": "save_draft", "mode": "revise", "ops": [op]}
    wanted = _doc_id(state, doc_id)
    if wanted:
        payload["scope"] = {"kind": "raise_deck", "docId": wanted}
    if int(version or 0) > 0:
        payload["baseVersion"] = int(version)
    if (note or "").strip():
        payload["note"] = note.strip()[:200]
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_author_response(status_code, body_text)
