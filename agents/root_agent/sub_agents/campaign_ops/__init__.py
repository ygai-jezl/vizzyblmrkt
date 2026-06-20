"""Campaign Ops Agent — Vizzy's email-operations specialist (ADK 2.x sub-agent).

Intentionally import-free: `agent.py` imports `google.adk`, so re-exporting it
here would force ADK onto importers of the (ADK-free, TYPE_CHECKING-guarded) tool
module. The root agent imports `campaign_ops_agent` by explicit path instead.
"""
