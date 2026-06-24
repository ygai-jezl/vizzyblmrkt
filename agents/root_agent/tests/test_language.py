"""Unit tests for the operator language directive (pure helper, no ADK needed)."""

from __future__ import annotations

from root_agent_pkg.context.language import language_directive, normalize_locale


def test_normalize_locale_coerces_variants():
    assert normalize_locale("fr-FR") == "fr"
    assert normalize_locale("PT_br") == "pt"
    assert normalize_locale("  EN ") == "en"
    assert normalize_locale("xx") is None
    assert normalize_locale("") is None
    assert normalize_locale(None) is None


def test_directive_empty_for_english_or_unknown():
    assert language_directive("en") == ""
    assert language_directive("EN") == ""
    assert language_directive(None) == ""
    assert language_directive("xx") == ""


def test_directive_names_target_language():
    directive = language_directive("fr")
    assert directive != ""
    assert "RESPOND IN French" in directive
    assert "Japanese" in language_directive("ja-JP")
