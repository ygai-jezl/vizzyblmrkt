"""Pure, ADK-free client logic for the get_brand_map and suggest_brand_map tools.

Mirrors email_style_client.py: the request/response logic lives here (no ADK import)
so it stays unit-testable without ADK; the only side effect — the HTTP call — is
isolated in `_request` so tests can monkeypatch it. Auth reuses the signed canvas
capability token (`ctxToken` in session state); the app takes the tenant and the
role from that token, never from here.

The brand map is brand-wide: what the brand is and is not, the names it uses, and the
subjects it wants to be known for with the questions people ask. Vizzy only ever files
SUGGESTIONS through the canvas endpoint: nothing in the map changes until an admin
accepts one on Brand › Brand map, and Vizzy never adds a link (profile links and home
pages are a person's to add on the page).

A map at any size (`atAnySize` in what the read returns) is read a part at a time: a
summary, the subjects near some words (`find`), one subject (`subject`), or what an import
of the brand's own research added (`import`). With buying situations on, Vizzy can also
propose situations (the moments that send people looking), link the questions it proposes
to one, and research the situations people are in or what people in one ask.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

READ_PATH = "/api/agent/brand-map"
CANVAS_PATH = "/api/agent/canvas"
_TIMEOUT_SECONDS = 30
# Research reads the brand's site and knowledge and runs a search: about a minute.
_RESEARCH_TIMEOUT_SECONDS = 80
_BRIEF_MAX = 500  # what the server reads

_OFF = "The brand map isn't switched on in this environment yet."
# Only when this chat has no token or callback URL — never "switched on", since the
# feature may well be on.
_NO_LINK = "I can't reach the app from this chat yet — please send that again."

_ERRORS = {
    # The flag is off, or the app predates the brand map (no kind, no read route).
    "unavailable": _OFF,
    "unknown_kind": _OFF,
    "http_404": _OFF,
    "forbidden": (
        "Only an admin can suggest changes to the brand map. An admin of this account can ask me, "
        "or change it in Brand › Brand map."
    ),
    "unauthorized": "My session to the app expired — please send your message again.",
    "canvas_auth_unconfigured": "The brand map from chat isn't set up in this environment yet.",
    "rate_limited": "I've made several brand map suggestions just now. Please try again in a few minutes.",
    "invalid_input": "Some of the suggestion wasn't valid",
    "links_not_allowed": (
        "I can't add links to the brand map from chat: profile links and home pages are added by a "
        "person on Brand › Brand map"
    ),
    "research_disabled": "Research for the brand map isn't switched on in this environment yet.",
    "no_model": "Research isn't available in this environment yet.",
    "nothing_to_read": (
        "There's nothing to research the brand from yet: add your site's domain in Settings, or "
        "knowledge to a programme, first."
    ),
    "research_failed": "Research didn't finish this time. Please try again in a minute.",
    "map_unreadable": "The saved brand map can't be read. An admin needs to look at it on Brand › Brand map.",
    "map_too_large": "The brand map is full. An admin needs to dismiss some suggestions on Brand › Brand map first.",
    "situations_disabled": "Buying situations aren't switched on in this environment yet.",
    "import_disabled": "Research from a PDF isn't switched on in this environment yet.",
    "no_subject": "That subject isn't on the brand map any more.",
    "no_situation": "That buying situation isn't on the brand map any more.",
    "no_import": "No research has been uploaded yet. It's uploaded as a PDF on Brand › Brand map › Your research.",
    "too_many_situations": "The brand map holds as many buying situations as it can.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}
# Whole on their own: the app's issues only say the same thing again.
_NO_DETAIL = {"links_not_allowed"}

_KINDS = {"product", "alternative", "integration", "audience", "use_case"}
_MAX_CHANGES = 20  # what the app takes in one call
_MAX_SITUATIONS = 10  # likewise, buying situations proposed in one call
# "add" files suggestions; the rest run research (about a minute each).
_MODES = {"add", "research", "situations", "situation_questions"}
_RESEARCHING = {"research", "situations", "situation_questions"}


def _request(method: str, url: str, token: str, payload: "dict | None" = None, timeout: int = _TIMEOUT_SECONDS) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
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


def _base_and_token(state: "dict | None") -> "tuple[str, str] | dict":
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    return base, token


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    issues = body.get("issues") or []
    base = _ERRORS.get(code, "I couldn't do that with the brand map just now. Please try again.")
    detail = "" if code in _NO_DETAIL else "; ".join(str(i) for i in issues[:8])
    return {
        "status": "error",
        "code": code,
        "issues": issues[:20],
        "message": f"{base}: {detail}" if detail else base,
    }


def _parts(value: str) -> "list[str]":
    """ "A | B | C" → ["A", "B", "C"], trimmed, empty parts dropped from the end."""
    parts = [p.strip() for p in (value or "").split("|")]
    while parts and not parts[-1]:
        parts.pop()
    return parts


def build_changes(
    brand_name: str = "",
    category: str = "",
    statement: str = "",
    is_not: "list | None" = None,
    avoid: "list | None" = None,
    subjects: "list | None" = None,
    questions: "list | None" = None,
    names: "list | None" = None,
    aliases: "list | None" = None,
) -> "tuple[list, list]":
    """The changes to suggest, and the lines that couldn't be read (said back, never guessed)."""
    changes: list = []
    unread: list = []
    for field, value in (("name", brand_name), ("category", category), ("statement", statement)):
        if (value or "").strip():
            changes.append({"type": "set_identity", "field": field, "value": value.strip()})
    for text in is_not or []:
        if str(text).strip():
            changes.append({"type": "add_is_not", "text": str(text).strip()})
    for line in avoid or []:
        p = _parts(str(line))
        if p:
            changes.append({"type": "add_avoid", "term": p[0], **({"useInstead": p[1]} if len(p) > 1 else {})})
    for name in subjects or []:
        if str(name).strip():
            changes.append({"type": "add_subject", "name": str(name).strip()})
    for line in questions or []:
        p = _parts(str(line))
        if len(p) >= 2 and p[0] and p[1]:
            changes.append({"type": "add_question", "subject": p[0], "text": p[1], **({"intent": p[2]} if len(p) > 2 else {})})
        elif p:
            unread.append(f'question "{line}": write it as "Subject | Question"')
    for line in names or []:
        p = _parts(str(line))
        kind = p[1].lower().replace(" ", "_") if len(p) > 1 else ""
        if p and p[0] and kind in _KINDS:
            changes.append({"type": "add_name", "name": p[0], "kind": kind})
        elif p:
            unread.append(f'name "{line}": write it as "Name | product, alternative, integration, audience or use_case"')
    for line in aliases or []:
        p = _parts(str(line))
        if len(p) >= 2 and p[0] and p[1]:
            changes.append({"type": "add_alias", "name": p[0], "alias": p[1]})
        elif p:
            unread.append(f'other spelling "{line}": write it as "Name | other spelling"')
    return changes, unread


def build_situations(lines: "list | None" = None) -> "tuple[list, list]":
    """Buying situations to propose, from "Situation in the buyer's words | who | what they want" lines."""
    situations: list = []
    unread: list = []
    for line in lines or []:
        p = _parts(str(line))
        if p and p[0]:
            situations.append({"text": p[0], **({"who": p[1]} if len(p) > 1 and p[1] else {}), **({"want": p[2]} if len(p) > 2 and p[2] else {})})
        elif str(line).strip():
            unread.append(f'situation "{line}": write it as "Situation in the buyer\'s words | who | what they want"')
    return situations, unread


def _mode(mode: str) -> str:
    m = (mode or "").strip().lower()
    return m if m in _MODES else "add"


def build_suggest_payload(
    mode: str,
    brief: str,
    changes: "list | None" = None,
    situations: "list | None" = None,
    situation_id: str = "",
    customers: str = "",
) -> dict:
    """The canvas request: the changes (and buying situations) to file as suggestions, or research."""
    payload: dict = {
        "kind": "brand_map",
        "action": "save_draft",
        "mode": _mode(mode),
        "brief": (brief or "")[:_BRIEF_MAX],
    }
    situation = (situation_id or "").strip()
    if payload["mode"] == "add":
        payload["changes"] = list(changes or [])[:_MAX_CHANGES]
        if situations:
            payload["situations"] = list(situations)[:_MAX_SITUATIONS]
        if situation:
            payload["situationId"] = situation
    elif payload["mode"] == "situations" and (customers or "").strip():
        payload["customers"] = customers.strip()[:300]
    elif payload["mode"] == "situation_questions" and situation:
        payload["situationId"] = situation
    return payload


def parse_suggest_response(status_code: int, body_text: str) -> dict:
    """Normalise the canvas endpoint's answer into a tool result (the card rides along)."""
    body = _json(body_text)
    if 200 <= status_code < 300 and body.get("ok"):
        return {
            "status": "success",
            "url": body.get("url"),
            "warnings": body.get("warnings", []),
            "card": body.get("card"),
            "message": body.get("summary")
            or "Filed suggestions for your brand map. Nothing in the map changes until an admin accepts them in Brand › Brand map.",
        }
    return error_result(status_code, body)


def read_path(find: str = "", subject_id: str = "", import_id: str = "") -> str:
    """The read route, asking for one part of a map at any size when given."""
    query = {k: v.strip() for k, v in (("find", find or ""), ("subject", subject_id or ""), ("import", import_id or "")) if v and v.strip()}
    return READ_PATH + (("?" + urllib.parse.urlencode(query)) if query else "")


def get_map(state: "dict | None", find: str = "", subject_id: str = "", import_id: str = "") -> dict:
    """Read the brand map: what is decided, what waits, and what is answered. Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + read_path(find, subject_id, import_id), token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def suggest(
    state: "dict | None",
    mode: str,
    brief: str,
    brand_name: str = "",
    category: str = "",
    statement: str = "",
    is_not: "list | None" = None,
    avoid: "list | None" = None,
    subjects: "list | None" = None,
    questions: "list | None" = None,
    names: "list | None" = None,
    aliases: "list | None" = None,
    situations: "list | None" = None,
    situation_id: str = "",
    customers: str = "",
) -> dict:
    """File brand map SUGGESTIONS for an admin to accept, or research the map. Never raises."""
    m = _mode(mode)
    research = m in _RESEARCHING
    changes, unread = ([], []) if research else build_changes(brand_name, category, statement, is_not, avoid, subjects, questions, names, aliases)
    proposed, unread_situations = ([], []) if research else build_situations(situations)
    unread = unread + unread_situations
    if m == "situation_questions" and not (situation_id or "").strip():
        return {"status": "error", "code": "no_situation_id", "message": "Say which buying situation to research: its id, from get_brand_map."}
    if not research and unread:
        return {"status": "error", "code": "unread", "issues": unread, "message": "Some of what you asked couldn't be read: " + "; ".join(unread)}
    if not research and not changes and not proposed:
        return {"status": "error", "code": "nothing_to_suggest", "message": "There was nothing to suggest. Say what to add, or ask me to research the map."}
    if len(proposed) > _MAX_SITUATIONS:
        return {
            "status": "error",
            "code": "too_many",
            "message": f"That's {len(proposed)} buying situations; I can suggest up to {_MAX_SITUATIONS} at once. Send them in parts.",
        }
    if not research and len(changes) > _MAX_CHANGES:
        # Never cut short in silence: the operator hears how many, and nothing is filed.
        return {
            "status": "error",
            "code": "too_many",
            "message": f"That's {len(changes)} changes; I can suggest up to {_MAX_CHANGES} at once. Send them in parts of {_MAX_CHANGES} or fewer.",
        }
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_suggest_payload(m, brief, changes, proposed, situation_id, customers)
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload, _RESEARCH_TIMEOUT_SECONDS if research else _TIMEOUT_SECONDS)
    return parse_suggest_response(status_code, body_text)
