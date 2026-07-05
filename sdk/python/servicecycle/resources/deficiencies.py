"""Mirrors sdk/src/resources/deficiencies.ts. Read-only by design."""

from __future__ import annotations

from typing import Any, Dict, Iterator

from .._util import camel_params
from ..http import HttpClient
from ..paginator import paginate


class DeficienciesResource:
    def __init__(self, http: HttpClient):
        self._http = http

    def list(self, **params: Any) -> Dict[str, Any]:
        """Kwargs: page, limit, status('OPEN'|'RESOLVED'),
        severity('IMMEDIATE'|'RECOMMENDED'|'ADVISORY'), asset_id."""
        return self._http.get("/deficiencies", camel_params(params))

    def get(self, deficiency_id: str) -> Dict[str, Any]:
        return self._http.get(f"/deficiencies/{deficiency_id}")["data"]

    def list_all(self, **params: Any) -> Iterator[Dict[str, Any]]:
        return paginate(lambda p: self._http.get("/deficiencies", camel_params(p)), params)
