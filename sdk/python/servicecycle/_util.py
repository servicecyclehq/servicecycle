"""Internal helpers shared by every resource module. Not part of the public API."""

from __future__ import annotations

from typing import Any, Dict


def snake_to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def camel_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """Convert Pythonic snake_case kwargs to the camelCase query-param/body
    names the API expects (siteId, assetId, dueBefore, ...), dropping any
    key whose value is None so optional filters aren't sent at all.
    """
    return {snake_to_camel(k): v for k, v in params.items() if v is not None}
