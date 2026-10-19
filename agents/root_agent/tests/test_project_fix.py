"""The project-number workaround reads the project id from AGENT_PROJECT_ID (set by deploy.sh)."""

from __future__ import annotations

import importlib

import pytest

project_fix = importlib.import_module("root_agent_pkg._project_fix")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.delenv("AGENT_PROJECT_ID", raising=False)


def test_a_project_number_becomes_the_id_from_agent_project_id(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "123456789012")
    monkeypatch.setenv("AGENT_PROJECT_ID", "my-project")
    project_fix._apply()
    assert project_fix.os.environ["GOOGLE_CLOUD_PROJECT"] == "my-project"


def test_a_literal_id_is_left_alone(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "already-an-id")
    monkeypatch.setenv("AGENT_PROJECT_ID", "my-project")
    project_fix._apply()
    assert project_fix.os.environ["GOOGLE_CLOUD_PROJECT"] == "already-an-id"


def test_without_agent_project_id_the_number_stays(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "123456789012")
    monkeypatch.setenv("AGENT_PROJECT_ID", "  ")
    project_fix._apply()
    assert project_fix.os.environ["GOOGLE_CLOUD_PROJECT"] == "123456789012"


def test_no_project_number_map_is_left_in_the_code():
    assert not hasattr(project_fix, "_PROJECT_NUMBER_TO_ID")
