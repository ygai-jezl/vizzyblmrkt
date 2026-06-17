"""Unit tests for Memory Bank composite scoping (prevents cross-tenant bleed)."""

from __future__ import annotations

from root_agent_pkg.context.memory_config import composite_user_id


def test_composite_key_format():
    assert composite_user_id("ten_vzb", "user-1") == "ten_vzb_user-1"


def test_same_user_different_tenants_get_distinct_scopes():
    a = composite_user_id("tenant-a", "shared-user")
    b = composite_user_id("tenant-b", "shared-user")
    assert a != b
