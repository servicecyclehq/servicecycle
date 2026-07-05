"""Mirrors sdk/src/resources/assets.ts."""

from __future__ import annotations

from typing import Any, Dict, Iterator

from .._util import camel_params
from ..http import HttpClient
from ..paginator import paginate


class AssetsResource:
    def __init__(self, http: HttpClient):
        self._http = http

    def list(self, **params: Any) -> Dict[str, Any]:
        """List assets. Kwargs: page, limit(<=100), equipment_type, site_id,
        governing_condition('C1'/'C2'/'C3'), in_service(bool), due_before(date).
        Returns {success, data: [...], pagination: {page, limit, total, pages}}.
        """
        return self._http.get("/assets", camel_params(params))

    def get(self, asset_id: str) -> Dict[str, Any]:
        """Full detail for one asset, including nameplateData/building/area/schedules."""
        return self._http.get(f"/assets/{asset_id}")["data"]

    def list_all(self, **params: Any) -> Iterator[Dict[str, Any]]:
        """Auto-paginating iterator over every asset matching the filters."""
        return paginate(lambda p: self._http.get("/assets", camel_params(p)), params)
