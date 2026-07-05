"""Mirrors sdk/src/resources/arcflash.ts.

Two endpoints on this resource skip the {success, data} envelope every other
endpoint in the API uses (work_order_precheck and create_device) -- handled
explicitly below rather than assumed, so a future envelope fix on the server
doesn't silently break this client.
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, Optional

from .._util import camel_params
from ..http import HttpClient
from ..paginator import paginate


class ArcFlashResource:
    def __init__(self, http: HttpClient):
        self._http = http

    def list_labels(self, **params: Any) -> Dict[str, Any]:
        """Kwargs: page, limit, site_id, severity('danger'|'warning')."""
        return self._http.get("/arc-flash/labels", camel_params(params))

    def list_all_labels(self, **params: Any) -> Iterator[Dict[str, Any]]:
        return paginate(lambda p: self._http.get("/arc-flash/labels", camel_params(p)), params)

    def get_one_line(self, site_id: str) -> Dict[str, Any]:
        """Power-path topology for a site: {site, svg, nodes, edges}."""
        return self._http.get("/arc-flash/one-line", {"siteId": site_id})

    def work_order_precheck(self, asset_id: str) -> Dict[str, Any]:
        """Check whether a work order can be issued on an energized asset.
        ALWAYS call this before creating a work order where is_energized is
        True. Block the work order when canIssue is False.

        Returns (bare, no envelope): {assetId, canIssue, reasons, hazard, study, disclaimer}
        """
        return self._http.get("/arc-flash/work-order-precheck", {"assetId": asset_id})

    def create_device(self, idempotency_key: Optional[str] = None, **params: Any) -> Dict[str, Any]:
        """Write verified protective-device settings back. Requires write scope.

        Kwargs: asset_id (required), label, device_type('breaker'|'fuse'|'relay'|'switch'),
        manufacturer, model, part_number, frame_rating_a, sensor_rating_a, settings.
        """
        return self._http.post("/arc-flash/devices", camel_params(params), idempotency_key)
