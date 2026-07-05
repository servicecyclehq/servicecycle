"""Mirrors sdk/src/resources/contractors.ts."""

from __future__ import annotations

from typing import Any, Dict, Iterator

from .._util import camel_params
from ..http import HttpClient
from ..paginator import paginate


class ContractorsResource:
    def __init__(self, http: HttpClient):
        self._http = http

    def list(self, **params: Any) -> Dict[str, Any]:
        """Kwargs: page, limit."""
        return self._http.get("/contractors", camel_params(params))

    def get(self, contractor_id: str) -> Dict[str, Any]:
        return self._http.get(f"/contractors/{contractor_id}")["data"]

    def list_all(self, **params: Any) -> Iterator[Dict[str, Any]]:
        return paginate(lambda p: self._http.get("/contractors", camel_params(p)), params)
