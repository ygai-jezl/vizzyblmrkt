"""Structured logger for GCP Cloud Logging.

Emits JSON to stdout/stderr that Cloud Logging auto-parses and indexes in
production; pretty-prints in dev. Trimmed port of the sibling supervisor's
logger — drops the contextvars request-context layer (which the marketing root
agent doesn't need yet) but keeps the same `logger.info(msg, **fields)` API the
ported callbacks rely on.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Optional

IS_PRODUCTION = (
    os.environ.get("NODE_ENV") == "production" or os.environ.get("ENV") == "production"
)


def _build_entry(severity: str, message: str, fields: Optional[dict]) -> dict:
    entry: dict[str, Any] = {
        "severity": severity,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if fields:
        for key, value in fields.items():
            if key == "error" and isinstance(value, Exception):
                entry["error"] = {"message": str(value), "type": type(value).__name__}
            else:
                entry[key] = value
    return entry


def _emit(entry: dict) -> None:
    stream = sys.stderr if entry.get("severity") == "ERROR" else sys.stdout
    if IS_PRODUCTION:
        print(json.dumps(entry, default=str), file=stream)
        return
    severity = entry.get("severity", "INFO")
    message = entry.get("message", "")
    extras = {
        k: v
        for k, v in entry.items()
        if k not in {"severity", "message", "timestamp"}
    }
    suffix = f"  {extras}" if extras else ""
    print(f"[{severity}] {message}{suffix}", file=stream)


class Logger:
    def debug(self, message: str, **fields: Any) -> None:
        _emit(_build_entry("DEBUG", message, fields or None))

    def info(self, message: str, **fields: Any) -> None:
        _emit(_build_entry("INFO", message, fields or None))

    def warn(self, message: str, **fields: Any) -> None:
        _emit(_build_entry("WARNING", message, fields or None))

    def error(self, message: str, **fields: Any) -> None:
        _emit(_build_entry("ERROR", message, fields or None))


logger = Logger()
