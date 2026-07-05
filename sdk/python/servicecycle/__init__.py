"""Official Python SDK for the ServiceCycle Public API.

Mirrors the TypeScript SDK (sdk/src) 1:1 in behavior -- same auth, same
retry/backoff on 429, same error taxonomy, same idempotency-key support,
same auto-paginating iterators (Pythonic generators instead of async
generators). See sdk/python/README.md for usage.
"""

from .client import ServiceCycleClient
from .errors import (
    AuthenticationError,
    AuthorizationError,
    NotFoundError,
    RateLimitError,
    ServiceCycleError,
    ValidationError,
)

__version__ = "0.1.0"

__all__ = [
    "ServiceCycleClient",
    "ServiceCycleError",
    "AuthenticationError",
    "AuthorizationError",
    "NotFoundError",
    "RateLimitError",
    "ValidationError",
]
