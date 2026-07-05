"""Error hierarchy for the ServiceCycle Python SDK.

Mirrors sdk/src/errors.ts (the official TypeScript SDK) 1:1 so the two
client libraries behave identically for anyone bouncing between languages.
"""

from __future__ import annotations

from typing import Any, Optional


class ServiceCycleError(Exception):
    """Base class for every error this SDK raises for a non-2xx response."""

    def __init__(self, message: str, status_code: int, raw: Optional[Any] = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.raw = raw

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"{type(self).__name__}({self.message!r}, status_code={self.status_code})"


class AuthenticationError(ServiceCycleError):
    """401 - the API key is missing, invalid, revoked, or expired."""

    def __init__(self):
        super().__init__("Invalid or missing API key", 401)


class AuthorizationError(ServiceCycleError):
    """403 - the API key is valid but lacks the required scope (e.g. 'write')."""

    def __init__(self, message: str = "API key lacks the required scope"):
        super().__init__(message, 403)


class NotFoundError(ServiceCycleError):
    """404 - the requested resource does not exist."""

    def __init__(self, resource: str = "Resource"):
        super().__init__(f"{resource} not found", 404)


class RateLimitError(ServiceCycleError):
    """429 - rate limit exceeded and automatic retries were exhausted.

    The API allows 60 requests/minute per key and 300/minute per IP. The
    client retries automatically (see http.py); this is only raised once
    max_retries is exhausted.
    """

    def __init__(self, retry_after_ms: int = 0):
        super().__init__(f"Rate limit exceeded. Retry after {retry_after_ms}ms", 429)
        self.retry_after_ms = retry_after_ms


class ValidationError(ServiceCycleError):
    """400 - the request body failed server-side validation."""

    def __init__(self, message: str = "Validation error"):
        super().__init__(message, 400)
