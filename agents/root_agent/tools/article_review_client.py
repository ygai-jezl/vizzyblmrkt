"""Pure, ADK-free client logic for the review_article tool.

Mirrors articles_due_client.py: the request/response logic lives here (no ADK import) so it stays
unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so tests
can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session state);
the app takes the brand from that token, never from here.

The tool starts a refresh review of a live blog article, or moves the running one on a step, and
says where it is and what it proposes. It never applies or dismisses a change: a person does, on
the article.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

PATH = "/api/agent/article-review"
# One step can take about a minute (the research step searches the web).
_TIMEOUT_SECONDS = 80

_OFF = "Refresh reviews from the chat aren't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."
_ARTICLE_ID = re.compile(r"^[A-Za-z0-9_-]{6,80}$")

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "not_found": "I couldn't find that live article. Ask me which articles are due a refresh, then pick one from that list.",
    "invalid_input": "That doesn't look like an article from the list of articles due a refresh.",
    "not_included": "Refresh reviews aren't included in this brand's plan.",
    "monthly_limit": "This brand has used its refresh reviews for this month.",
    "autopilot_running": "The autopilot is writing that article right now. Try again once it's done.",
    "not_live": "That article isn't marked live, so there's nothing to refresh yet.",
    "rate_limited": "I've started a lot of reviews just now. Please try again in a minute.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reviewing articles from chat isn't set up in this environment yet.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}


def _request(method: str, url: str, token: str, body: "dict | None" = None, timeout: int = _TIMEOUT_SECONDS) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"X-Canvas-Context": token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
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
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't review that article just now. Please try again.")}


def review_article(state: "dict | None", article_id: str, move_on: bool = True) -> dict:
    """Start or move on a refresh review (move_on), or only say where it is. Never raises."""
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    article_id = (article_id or "").strip()
    if not _ARTICLE_ID.match(article_id):
        return {"status": "error", "code": "invalid_input", "message": _ERRORS["invalid_input"]}
    if move_on:
        status_code, body_text = _request("POST", f"{base}{PATH}", token, {"articleId": article_id})
    else:
        query = urllib.parse.urlencode({"articleId": article_id})
        status_code, body_text = _request("GET", f"{base}{PATH}?{query}", token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)
