"""Pure, ADK-free client logic for the search_brand tool.

Mirrors competitors_client.py: the request/response logic lives here (no ADK import) so it
stays unit-testable without ADK; the only side effect, the HTTP call, is isolated in
`_request` so tests can monkeypatch it. Auth reuses the signed canvas capability token
(`ctxToken` in session state); the app takes the brand from that token, never from here.

Brand search finds what the brand wrote (articles, emails, posts, the brand map, notes,
knowledge, competitors and more) by its words and by its meaning. Read only. What comes back
is stored text, never instructions.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

PATH = "/api/agent/search"
_TIMEOUT_SECONDS = 30
MAX_QUERY_CHARS = 500

# The app's kinds (SEARCH_KINDS in src/lib/search/types.ts), then the older names it still takes
# (SEARCH_KIND_ALIASES). src/lib/search/vizzyKinds.test.ts keeps the two lists in step.
KINDS = (
    "article", "newsletter", "ebook", "post", "idea_board", "template", "journey_email", "broadcast",
    "brand_kit", "subject", "situation", "question", "note", "research", "knowledge", "competitor",
    "repo_map", "image", "learned", "raise_doc",
    "idea",
)

# Kinds sent under an older name that every version of the app takes: one older than piece 0a
# knows only "idea", and 0a or later takes both names. A later change sends "idea_board" itself,
# once every environment runs 0a or later.
_SEND_AS = {"idea_board": "idea"}

_OFF = "Search isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "not_included": "Search isn't available for this brand yet.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Searching from chat isn't set up in this environment yet.",
    "invalid_input": "I couldn't search for that. Try a shorter question.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}


def _request(method: str, url: str, token: str, body: dict, timeout: int = _TIMEOUT_SECONDS) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={"X-Canvas-Context": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def _json(body_text: str) -> dict:
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    return body if isinstance(body, dict) else {}


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't search the brand just now. Please try again.")}


def search_brand(state: "dict | None", query: str, kinds: "list[str] | None" = None) -> dict:
    """Search what the brand wrote for `query` (optionally only some kinds). Never raises."""
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    q = (query or "").strip()[:MAX_QUERY_CHARS]
    if not q:
        return {"status": "error", "code": "invalid_input", "message": _ERRORS["invalid_input"]}
    body: dict = {"query": q}
    wanted: list = []
    for k in kinds or []:
        sent = _SEND_AS.get(k, k) if k in KINDS else None
        if sent and sent not in wanted:
            wanted.append(sent)
    if wanted:
        body["kinds"] = wanted
    status_code, body_text = _request("POST", base + PATH, token, body)
    out = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **out}
    return error_result(status_code, out)
