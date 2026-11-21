"""`list_connections` and `read_connected_live` FunctionTools: Vizzy reads the brand's connected data.

IMPORTANT (same as search.py): ADK resolves the parameter annotations at runtime to find and
strip the injected `tool_context`, so `ToolContext` must be a real runtime import and this module
must NOT use `from __future__ import annotations`. The pure logic lives in connectors_client.py.
"""

from google.adk.tools import ToolContext

from . import connectors_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def list_connections(tool_context: ToolContext) -> dict:
    """List the brand's connected data that Vizzy may read: Cloudflare, Search Console, Google Analytics.

    Each connection has its `id`, `connector`, `label`, `health` (ok, check, broken or paused) and
    `problem` in plain words, `canRead` with `cannotReadBecause` when it can't, and its `streams`:
    each stream's name, a description, how it can be grouped (`by`: day, page or topic), its
    `lag` (how long a day's numbers take to settle) and its `measures`, explained in `meanings`.
    `notShared` is true when the brand has other connections an admin hasn't let Vizzy read: say so,
    and that an admin can allow it. Read only: Vizzy never connects, changes or disconnects anything.
    """
    return client.list_connections(_state(tool_context))


def read_connected_live(
    tool_context: ToolContext,
    connection_id: str,
    stream: str,
    from_date: str,
    to_date: str,
    by: str = "day",
    limit: int = 50,
) -> dict:
    """Read a connection's numbers live, every number with its meaning.

    Use an `id` and a stream from `list_connections`. At most 93 days and 100 rows. Rows hold the
    grouping key (`day`, `page` as a path, or `query` for a search) and the stream's numbers;
    `meanings` explains each number (definition, grain, caveat), `lag` says how long a day takes to
    settle and `notes` say what to bear in mind (numbers not final yet, sampled or held back).
    Explain figures with their meanings and never invent one the answer didn't give. Read only.

    Args:
        connection_id: The connection's id (dcn_...), from list_connections.
        stream: The stream to read, from that connection's streams (e.g. search_performance).
        from_date: The first day, YYYY-MM-DD.
        to_date: The last day, YYYY-MM-DD, not in the future.
        by: "day", "page" or "topic" (searches); only what the stream allows.
        limit: How many rows, 1 to 100 (default 50).
    """
    return client.read_connected_live(_state(tool_context), connection_id, stream, from_date, to_date, by, limit)
