"""Unit tests for the Email style tool client (ADK-free; the HTTP call is monkeypatched)."""

from __future__ import annotations

import json

from root_agent_pkg.prompts.system_instruction import ROOT_SYSTEM_INSTRUCTION
from root_agent_pkg.tools import email_style_client as es

STATE = {"ctxToken": "tok"}
JOURNEY_KEYS = {"journeyId", "journeyStatus", "waveId"}


def _capture(monkeypatch, status=200, body=None):
    calls = []

    def fake(method, url, token, payload=None):
        calls.append({"method": method, "url": url, "token": token, "payload": payload})
        return status, body if isinstance(body, str) else json.dumps(body if body is not None else {})

    monkeypatch.setattr(es, "_request", fake)
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com/")
    return calls


def test_reads_the_style_with_the_session_token(monkeypatch):
    calls = _capture(monkeypatch, 200, {"url": "/admin/brand-kit/email-style", "canSuggest": True, "current": None})
    out = es.get_style(STATE)
    assert out == {"status": "success", "url": "/admin/brand-kit/email-style", "canSuggest": True, "current": None}
    assert calls == [
        {"method": "GET", "url": "https://app.example.com/api/agent/email-style", "token": "tok", "payload": None}
    ]


def test_suggest_sends_only_the_fields_given(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    es.suggest_style(STATE, "edit", "make the header navy", header_color=" #1B2A4A ")
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "https://app.example.com/api/agent/canvas"
    assert calls[0]["token"] == "tok"
    assert calls[0]["payload"] == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "edit",
        "brief": "make the header navy",
        "headerColor": "#1B2A4A",
    }
    full = es.build_suggest_payload("brand_kit", "use my brand kit", "#111111", "#ff6b35", "primary", "Acme")
    assert full == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "brand_kit",
        "brief": "use my brand kit",
        "headerColor": "#111111",
        "buttonColor": "#ff6b35",
        "logo": "primary",
        "companyName": "Acme",
    }


def test_hide_company_name_sends_null():
    p = es.build_suggest_payload("edit", "logo only please", company_name="Acme", hide_company_name=True)
    assert "companyName" in p and p["companyName"] is None
    assert "companyName" not in es.build_suggest_payload("edit", "", company_name="  ")


def test_a_gradient_header_sends_both_colours(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    es.suggest_style(
        STATE,
        "edit",
        "make the header a purple-to-indigo gradient",
        header_color="#7c3aed",
        header_gradient_color=" #4F46E5 ",
    )
    assert calls[0]["payload"] == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "edit",
        "brief": "make the header a purple-to-indigo gradient",
        "headerColor": "#7c3aed",
        "headerGradientColor": "#4F46E5",
    }


def test_solid_header_sends_null_and_wins_over_a_colour_2():
    p = es.build_suggest_payload("edit", "make the header solid again", header_gradient_color="#4f46e5", solid_header=True)
    assert "headerGradientColor" in p and p["headerGradientColor"] is None


def test_the_header_text_colour_is_lowercased(monkeypatch):
    assert es.build_suggest_payload("edit", "", header_text_color=" White ")["headerText"] == "white"
    assert es.build_suggest_payload("edit", "", header_text_color="AUTO")["headerText"] == "auto"
    calls = _capture(monkeypatch, 200, {"ok": True})
    es.suggest_style(STATE, "edit", "make the header text black", header_text_color="Black")
    assert calls[0]["payload"]["headerText"] == "black"


def test_blank_header_options_send_nothing():
    p = es.build_suggest_payload("edit", "", header_gradient_color="  ", header_text_color=" ")
    assert not {"headerGradientColor", "headerText"} & set(p)
    assert not {"headerGradientColor", "headerText"} & set(es.build_suggest_payload("edit", "make the header navy"))


def test_a_header_image_is_sent_by_its_id(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    es.suggest_style(STATE, "edit", "use my Spring banner as the email header", header_image=" hdr_Spring1 ")
    assert calls[0]["payload"] == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "edit",
        "brief": "use my Spring banner as the email header",
        # Ids are case-sensitive, so only the spaces go.
        "headerImage": "hdr_Spring1",
    }


def test_none_goes_back_to_the_colour_header(monkeypatch):
    assert es.build_suggest_payload("edit", "", header_image="none")["headerImage"] == "none"
    assert es.build_suggest_payload("edit", "", header_image=" None ")["headerImage"] == "none"
    calls = _capture(monkeypatch, 200, {"ok": True})
    es.suggest_style(STATE, "edit", "go back to the colour header", header_image="none")
    assert calls[0]["payload"]["headerImage"] == "none"


def test_a_blank_header_image_sends_nothing():
    assert "headerImage" not in es.build_suggest_payload("edit", "", header_image="  ")
    assert "headerImage" not in es.build_suggest_payload("edit", "make the header navy", "#000080")


def test_header_images_errors_become_plain_messages(monkeypatch):
    issue = "headerImage: not one of your header images — upload one in Brand › Email style"
    _capture(monkeypatch, 400, {"error": "invalid_header_image", "issues": [issue]})
    out = es.suggest_style(STATE, "edit", "use my Spring banner", header_image="hdr_gone")
    assert out == {
        "status": "error",
        "code": "invalid_header_image",
        "issues": [issue],
        "message": f"That header image can't be used: {issue}",
    }
    _capture(monkeypatch, 503, {"error": "header_images_unavailable"})
    for out in (es.get_style(STATE), es.suggest_style(STATE, "edit", "", header_image="hdr_spring")):
        assert out["code"] == "header_images_unavailable"
        assert out["message"] == "I couldn't read your header images just now. Please try again."


def test_header_options_switched_off_says_so_once(monkeypatch):
    issue = (
        "headerGradientColor/headerText/headerImage: gradient headers, header text colour and header "
        "images aren't switched on here yet"
    )
    _capture(monkeypatch, 400, {"error": "header_options_unavailable", "issues": [issue]})
    out = es.suggest_style(STATE, "edit", "a purple-to-indigo gradient", "#7c3aed", header_gradient_color="#4f46e5")
    assert out == {
        "status": "error",
        "code": "header_options_unavailable",
        "issues": [issue],
        # The app's issue says the same thing, so it isn't tacked on.
        "message": (
            "Gradient headers, header text colour and header images aren't switched on in this environment yet."
        ),
    }
    out = es.suggest_style(STATE, "edit", "use my Spring banner", header_image="hdr_spring")
    assert out["message"].count("header images") == 1


def test_a_theme_and_fonts_are_sent_as_lowercase_ids(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    es.suggest_style(
        STATE,
        "edit",
        "make my emails feel more editorial, with Playfair headings",
        theme=" Editorial ",
        heading_font="Playfair-Display",
        body_font=" GEORGIA ",
    )
    assert calls[0]["payload"] == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "edit",
        "brief": "make my emails feel more editorial, with Playfair headings",
        "theme": "editorial",
        "headingFont": "playfair-display",
        "bodyFont": "georgia",
    }
    # A font alone keeps the look.
    assert es.build_suggest_payload("edit", "", body_font="inter") == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "edit",
        "brief": "",
        "bodyFont": "inter",
    }


def test_a_font_given_by_its_label_is_sent_as_its_id():
    for given, sent in (
        ("Playfair Display", "playfair-display"),
        (" playfair_display ", "playfair-display"),
        ("Trebuchet MS", "trebuchet"),
        ("trebuchet", "trebuchet"),
        ("Inter", "inter"),
    ):
        p = es.build_suggest_payload("edit", "", heading_font=given, body_font=given)
        assert p["headingFont"] == sent and p["bodyFont"] == sent
    # A font email doesn't have is sent the same way, for the app to refuse.
    assert es.build_suggest_payload("edit", "", heading_font="Comic Sans")["headingFont"] == "comic-sans"


def test_use_brand_fonts_sends_true_only_when_asked(monkeypatch):
    calls = _capture(monkeypatch, 200, {"ok": True})
    es.suggest_style(STATE, "edit", "use my brand fonts in emails", use_brand_fonts=True)
    assert calls[0]["payload"] == {
        "kind": "email_style",
        "action": "save_draft",
        "mode": "edit",
        "brief": "use my brand fonts in emails",
        "useBrandFonts": True,
    }
    # A font given as well rides along; the app lets it win.
    p = es.build_suggest_payload("edit", "", heading_font="lora", use_brand_fonts=True)
    assert p["useBrandFonts"] is True and p["headingFont"] == "lora"
    assert "useBrandFonts" not in es.build_suggest_payload("edit", "make the header navy", "#000080")


def test_blank_theme_fields_send_nothing():
    keys = {"theme", "headingFont", "bodyFont", "useBrandFonts"}
    assert not keys & set(es.build_suggest_payload("edit", "", theme="  ", heading_font=" ", body_font=""))
    assert not keys & set(es.build_suggest_payload("edit", "make the header navy", "#000080", "#ff6b35"))
    assert not keys & set(es.build_suggest_payload("brand_kit", "use my brand kit"))


def test_themes_switched_off_says_so_once(monkeypatch):
    issue = "theme/headingFont/bodyFont/useBrandFonts: email themes and fonts aren't switched on here yet"
    _capture(monkeypatch, 400, {"error": "themes_unavailable", "issues": [issue]})
    out = es.suggest_style(STATE, "edit", "make my emails feel more editorial", theme="editorial")
    assert out == {
        "status": "error",
        "code": "themes_unavailable",
        "issues": [issue],
        # The app's issue says the same thing, so it isn't tacked on.
        "message": "Email themes and fonts aren't switched on in this environment yet.",
    }
    out = es.suggest_style(STATE, "edit", "use my brand fonts in emails", use_brand_fonts=True)
    assert out["message"].count("switched on") == 1


def test_an_unknown_font_is_relayed_with_the_apps_issue(monkeypatch):
    issue = "headingFont: Invalid enum value"
    _capture(monkeypatch, 400, {"error": "invalid_input", "issues": [issue]})
    out = es.suggest_style(STATE, "edit", "use Comic Sans for headings", heading_font="comic-sans")
    assert out["code"] == "invalid_input"
    assert out["message"] == f"Some of the style wasn't valid: {issue}"


def test_a_long_brief_is_cut_to_what_the_server_keeps():
    assert len(es.build_suggest_payload("edit", "x" * 4000)["brief"]) == 500


def test_no_token_or_callback_says_it_cant_reach_the_app(monkeypatch):
    monkeypatch.setattr(es, "_request", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    monkeypatch.setenv("CANVAS_CALLBACK_URL", "https://app.example.com")
    outs = [es.get_style({}), es.suggest_style(None, "brand_kit", "")]
    monkeypatch.delenv("CANVAS_CALLBACK_URL")
    outs += [es.get_style(STATE), es.suggest_style(STATE, "brand_kit", "")]
    for out in outs:
        assert out["status"] == "error"
        assert "can't reach the app" in out["message"]
        assert "switched on" not in out["message"]


def test_errors_become_plain_messages(monkeypatch):
    off = "Email style isn't switched on in this environment yet."
    for status, body, code, says in [
        (503, {"error": "unavailable"}, "unavailable", off),
        (400, {"error": "unknown_kind", "known": ["journey"]}, "unknown_kind", off),
        (404, "<html>Not found</html>", "http_404", off),
        (403, {"error": "forbidden"}, "forbidden", "Only an admin can suggest an email style"),
        (401, {"error": "unauthorized", "reason": "expired"}, "unauthorized", "session to the app expired"),
        (429, {"error": "rate_limited"}, "rate_limited", "try again in a few minutes"),
        (400, {"error": "invalid_input", "issues": ["headerColor: Invalid"]}, "invalid_input", "headerColor: Invalid"),
        (400, {"error": "invalid_logo", "issues": ["logo: not one of your logos"]}, "invalid_logo", "not one of your logos"),
        (0, {"error": "network_error", "detail": "timed out"}, "network_error", "couldn't reach the app"),
        (500, "not json", "http_500", "Please try again"),
    ]:
        _capture(monkeypatch, status, body)
        for out in (es.get_style(STATE), es.suggest_style(STATE, "edit", "")):
            assert out["status"] == "error" and out["code"] == code
            assert says in out["message"]
            # Only the feature being off (or the app predating it) says "switched on".
            assert ("switched on" in out["message"]) == (says == off)


def test_success_relays_the_card_without_journey_keys(monkeypatch):
    card = {
        "kind": "email_style",
        "id": "email_style",
        "title": "Email style suggestion",
        "url": "/admin/brand-kit/email-style",
        "stats": [{"label": "header", "value": "#1b2a4a"}, {"label": "button", "value": "#ff6b35"}],
        "warnings": 0,
        "note": "Suggestion — nothing changes until an admin applies it.",
        "cta": "Review and apply",
    }
    _capture(
        monkeypatch,
        200,
        {
            "ok": True,
            "kind": "email_style",
            "id": "email_style",
            "journeyId": "email_style",
            "status": "suggested",
            "url": card["url"],
            "warnings": [],
            "summary": "Suggested an Email style. It's only a suggestion.",
            "card": card,
        },
    )
    out = es.suggest_style(STATE, "brand_kit", "use my brand kit for my emails")
    assert out == {
        "status": "success",
        "url": card["url"],
        "warnings": [],
        "card": card,
        "message": "Suggested an Email style. It's only a suggestion.",
    }
    assert not JOURNEY_KEYS & set(out)


def test_root_routes_email_style_to_the_tools_as_a_suggestion():
    assert "get_email_style" in ROOT_SYSTEM_INSTRUCTION
    assert "suggest_email_style" in ROOT_SYSTEM_INSTRUCTION
    assert "only a suggestion" in ROOT_SYSTEM_INSTRUCTION
    assert "not one email in a journey" in ROOT_SYSTEM_INSTRUCTION
    # Header options only when the read says they're on; logo clean-up stays on the page.
    assert "header_gradient_color" in ROOT_SYSTEM_INSTRUCTION
    assert "headerOptions" in ROOT_SYSTEM_INSTRUCTION
    # The clean-up pointer sits under `headerOptions: true` (the page has it only then, for
    # admins); without it, Vizzy says it isn't on and offers a transparent PNG instead.
    on = ROOT_SYSTEM_INSTRUCTION.index("returns `headerOptions: true`")
    cleanup = ROOT_SYSTEM_INSTRUCTION.index("an admin can remove a logo's white background")
    off = ROOT_SYSTEM_INSTRUCTION.index("Without `headerOptions`, say those aren't switched on yet")
    assert on < cleanup < off
    assert "transparent PNG in Brand › Logos" in ROOT_SYSTEM_INSTRUCTION[off:]
    # A header image by id (or "none") only under `headerOptions: true`; Vizzy can't upload one.
    assert "header_image" in ROOT_SYSTEM_INSTRUCTION
    assert "headerImages" in ROOT_SYSTEM_INSTRUCTION
    image = ROOT_SYSTEM_INSTRUCTION.index("`header_image` = an id from `headerImages`")
    upload = ROOT_SYSTEM_INSTRUCTION.index("point the operator to Brand › Email style to upload a banner")
    assert on < image < upload < off
    # A banner in use hides the gradient, text colour, logo and name: Vizzy asks before dropping it.
    hides = ROOT_SYSTEM_INSTRUCTION.index("the banner hides the logo, name, gradient and header text colour")
    drop = ROOT_SYSTEM_INSTRUCTION.index('also send `header_image` "none"')
    assert upload < hides < drop < off


def test_root_routes_themes_and_fonts_to_the_suggestion_only_when_on():
    bullet = next(line for line in ROOT_SYSTEM_INSTRUCTION.splitlines() if "**Email style**" in line)
    # One sentence, after the header options' and before the relay rule.
    options_off = bullet.index("Without `headerOptions`, say those aren't switched on yet")
    on = bullet.index("When `get_email_style` returns `themes: true`")
    off = bullet.index("without `themes`, say themes and fonts aren't switched on yet.")
    relay = bullet.index("If a tool says it isn't switched on")
    assert options_off < on < off < relay
    themes = bullet[on:off]
    assert themes.count(". ") == 0
    for words in (
        "make my emails feel more editorial",
        '`theme` "editorial"',
        "`themePresets`",
        "`heading_font`",
        "`body_font`",
        "`fonts`",
        "`use_brand_fonts`",
        "use my brand fonts in emails",
    ):
        assert words in themes
    # Web fonts reach few inboxes, and Vizzy says so, as the read's note has it: while web
    # fonts are off (themes on), every inbox shows the fallback.
    note = themes.index("what the read's `note` says about web fonts")
    few = themes.index("only in Apple Mail, Outlook for Mac and a few other inboxes")
    web_off = themes.index("while web fonts aren't switched on every inbox shows the fallback")
    assert note < few < web_off
    assert "fallback" in themes
