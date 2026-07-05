"""Mirrors sdk/src/client.ts."""

from __future__ import annotations

from .http import DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, HttpClient
from .resources.arcflash import ArcFlashResource
from .resources.assets import AssetsResource
from .resources.contractors import ContractorsResource
from .resources.deficiencies import DeficienciesResource
from .resources.identity import IdentityResource
from .resources.telemetry import TelemetryResource
from .resources.workorders import WorkOrdersResource


class ServiceCycleClient:
    """Python client for the ServiceCycle Public API.

    Example:
        >>> from servicecycle import ServiceCycleClient
        >>> client = ServiceCycleClient(api_key="sc_your_key_here")
        >>> client.identity.me()
    """

    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL,
                 max_retries: int = DEFAULT_MAX_RETRIES, timeout: float = 30.0):
        """
        Args:
            api_key: API key starting with 'sc_'. Issued in Settings -> API Keys.
            base_url: Base URL of the ServiceCycle API. Default: production.
            max_retries: Max automatic retries on HTTP 429 (rate limit). Default 3.
            timeout: Per-request socket timeout in seconds. Default 30.
        """
        http = HttpClient(api_key=api_key, base_url=base_url, max_retries=max_retries, timeout=timeout)

        self.identity = IdentityResource(http)
        self.assets = AssetsResource(http)
        self.contractors = ContractorsResource(http)
        self.work_orders = WorkOrdersResource(http)
        self.deficiencies = DeficienciesResource(http)
        self.arc_flash = ArcFlashResource(http)
        self.telemetry = TelemetryResource(http)
