"""Mirrors sdk/src/resources/workorders.ts."""

from __future__ import annotations

from typing import Any, Dict, Iterator, Optional

from .._util import camel_params
from ..http import HttpClient
from ..paginator import paginate


class WorkOrdersResource:
    def __init__(self, http: HttpClient):
        self._http = http

    def list(self, **params: Any) -> Dict[str, Any]:
        """Kwargs: page, limit, status('SCHEDULED'|'IN_PROGRESS'|'COMPLETE'|'CANCELLED'),
        asset_id, completed_after."""
        return self._http.get("/work-orders", camel_params(params))

    def get(self, work_order_id: str) -> Dict[str, Any]:
        return self._http.get(f"/work-orders/{work_order_id}")["data"]

    def create(self, idempotency_key: Optional[str] = None, **params: Any) -> Dict[str, Any]:
        """Create a work order. Requires write scope.

        Kwargs: asset_id (required), schedule_id, status('SCHEDULED'|'COMPLETE',
        default COMPLETE), completed_date, scheduled_date,
        as_left_condition('C1'/'C2'/'C3'), neta_decal('GREEN'/'YELLOW'/'RED'),
        notes (<=5000 chars).

        Pass idempotency_key when retrying a request that may have already
        succeeded (e.g. after a timeout) so the server only creates one
        record.
        """
        return self._http.post("/work-orders", camel_params(params), idempotency_key)["data"]

    def list_all(self, **params: Any) -> Iterator[Dict[str, Any]]:
        return paginate(lambda p: self._http.get("/work-orders", camel_params(p)), params)
