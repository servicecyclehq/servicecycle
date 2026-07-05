"""Mirrors sdk/src/resources/telemetry.ts."""

from __future__ import annotations

from typing import Any, Dict, Iterator, List, Optional

from .._util import camel_params
from ..http import HttpClient
from ..paginator import paginate


class TelemetryResource:
    def __init__(self, http: HttpClient):
        self._http = http

    def list_channels(self, **params: Any) -> List[Dict[str, Any]]:
        """Kwargs: asset_id, page, limit(<=500, default 200)."""
        return self._http.get("/telemetry/channels", camel_params(params))["data"]

    def upsert_channel(self, **params: Any) -> Dict[str, Any]:
        """Create or update a channel by (asset_id, key). Requires write scope.

        Kwargs: asset_id, key (required), label, unit, warn_high, crit_high,
        warn_low, crit_low, enabled.
        """
        return self._http.post("/telemetry/channels", camel_params(params))["data"]

    def list_readings(self, **params: Any) -> Dict[str, Any]:
        """Kwargs: asset_id, channel, since, page, limit(<=500)."""
        return self._http.get("/telemetry/readings", camel_params(params))

    def list_all_readings(self, **params: Any) -> Iterator[Dict[str, Any]]:
        return paginate(lambda p: self._http.get("/telemetry/readings", camel_params(p)), params)

    def ingest_readings(self, readings: List[Dict[str, Any]], idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """Ingest 1-1000 readings in a single batch call. CRIT breaches
        auto-escalate the asset's governing condition to at least C2.
        Requires write scope. Pass idempotency_key for safe retries.

        Each reading dict: {asset_id, channel, value, unit?, recorded_at?,
        source?, external_id?}.

        Returns: {accepted, breaches, duplicates, total, results: [...]}.
        """
        body = {"readings": [camel_params(r) for r in readings]}
        return self._http.post("/telemetry/readings", body, idempotency_key)["data"]

    def list_notifications(self, **params: Any) -> Dict[str, Any]:
        """Kwargs: status('open'|'all', default 'open'), asset_id.
        Returns (no pagination envelope -- hard-capped at 200 server-side):
        {data: [...], count}.
        """
        raw = self._http.get("/telemetry/notifications", camel_params(params))
        return {"data": raw["data"], "count": raw.get("count")}

    def acknowledge_notification(self, notification_id: str) -> Dict[str, Any]:
        """Acknowledge a WARN/CRIT notification. Requires write scope."""
        return self._http.post(f"/telemetry/notifications/{notification_id}/acknowledge")["data"]
