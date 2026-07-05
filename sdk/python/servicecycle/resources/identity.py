"""Mirrors sdk/src/resources/identity.ts."""

from __future__ import annotations

from typing import Any, Dict

from ..http import HttpClient


class IdentityResource:
    def __init__(self, http: HttpClient):
        self._http = http

    def me(self) -> Dict[str, Any]:
        """Return the authenticated API key's metadata. Use as a credential health check.

        Response: {keyId, keyName, scopes, accountId, companyName}
        """
        return self._http.get("/me")["data"]
