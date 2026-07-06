"""Zero-dependency HTTP transport for the ServiceCycle Python SDK.

Mirrors sdk/src/http.ts: same auth header, same retry-on-429 behavior (honors
Retry-After, defaults to 60s if absent), same status-code -> error mapping.
Uses only the Python standard library (urllib) -- no `requests` dependency,
matching the TS SDK's "no external runtime dependencies" design.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from .errors import (
    AuthenticationError,
    AuthorizationError,
    NotFoundError,
    RateLimitError,
    ServiceCycleError,
    ValidationError,
)

DEFAULT_BASE_URL = "https://servicecycle.app/api/v1"
DEFAULT_MAX_RETRIES = 3


class _StripAuthOnCrossOriginRedirect(urllib.request.HTTPRedirectHandler):
    """[2026-07-05] Python's stdlib redirect_request() resends the ORIGINAL
    request's headers -- including Authorization -- to whatever Location a
    redirect names, with no origin check at all (confirmed against the
    urllib.request docs: "Headers added to a request are also added to
    redirected requests"). This is unlike the TS sibling SDK, which rides on
    the platform fetch() / undici -- those strip Authorization on a
    cross-origin redirect per the WHATWG Fetch spec. Since this SDK's only
    intended target is the ServiceCycle API itself, any redirect to a
    different origin is unexpected; strip the API key rather than silently
    resending it to a host the caller never configured (DNS compromise,
    misconfigured base_url pointed at a proxy, open-redirect bug, etc.).
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is None:
            return None
        orig = urllib.parse.urlsplit(req.full_url)
        dest = urllib.parse.urlsplit(newurl)
        if (orig.scheme, orig.hostname, orig.port) != (dest.scheme, dest.hostname, dest.port):
            new_req.remove_header("Authorization")
        return new_req


# Built once -- the handler is stateless, no need to rebuild per request.
_REDIRECT_SAFE_OPENER = urllib.request.build_opener(_StripAuthOnCrossOriginRedirect)


def _build_url(base_url: str, path: str, params: Optional[Dict[str, Any]] = None) -> str:
    url = base_url.rstrip("/") + "/" + path.lstrip("/")
    if params:
        clean = {}
        for k, v in params.items():
            if v is None:
                continue
            clean[k] = "true" if v is True else ("false" if v is False else str(v))
        if clean:
            url += "?" + urllib.parse.urlencode(clean)
    return url


class HttpClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, max_retries: int = DEFAULT_MAX_RETRIES,
                 timeout: float = 30.0):
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.max_retries = max_retries
        self.timeout = timeout

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("GET", path, params=params)

    def post(self, path: str, body: Optional[Dict[str, Any]] = None,
              idempotency_key: Optional[str] = None) -> Any:
        return self._request("POST", path, body=body, idempotency_key=idempotency_key)

    def _request(self, method: str, path: str, params: Optional[Dict[str, Any]] = None,
                 body: Optional[Dict[str, Any]] = None, idempotency_key: Optional[str] = None,
                 attempt: int = 0) -> Any:
        url = _build_url(self.base_url, path, params)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with _REDIRECT_SAFE_OPENER.open(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            status = e.code
            payload: Dict[str, Any] = {}
            try:
                raw = e.read()
                if raw:
                    payload = json.loads(raw)
            except Exception:
                pass

            if status == 429:
                if attempt >= self.max_retries:
                    raise RateLimitError(0)
                retry_after = e.headers.get("Retry-After") if e.headers else None
                # [2026-07-05 review fix] Mirrors the TS SDK fix: unbounded
                # Retry-After let a misbehaving/malicious server hang the
                # client indefinitely, and a non-numeric header raised an
                # uncaught ValueError here (worse than the JS NaN case).
                # Clamp to a sane (0, 60]s window; fall back to 60s when
                # absent, non-numeric, or non-positive.
                try:
                    _parsed = float(retry_after) if retry_after else None
                except (TypeError, ValueError):
                    _parsed = None
                delay_s = min(_parsed, 60.0) if _parsed and _parsed > 0 else 60.0
                time.sleep(delay_s)
                return self._request(method, path, params=params, body=body,
                                      idempotency_key=idempotency_key, attempt=attempt + 1)
            if status == 401:
                raise AuthenticationError()
            if status == 403:
                raise AuthorizationError(payload.get("error") or "API key lacks the required scope")
            if status == 404:
                raise NotFoundError(payload.get("error") or "Resource")
            if status == 400:
                raise ValidationError(payload.get("error") or "Validation error")
            raise ServiceCycleError(payload.get("error") or f"HTTP {status}", status, payload)
        except urllib.error.URLError as e:
            # Network-level failure (DNS, connection refused, timeout) -- not
            # an API error, so it isn't wrapped in ServiceCycleError. Callers
            # that want to retry network errors should do so themselves.
            raise
