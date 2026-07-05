#!/usr/bin/env python3
"""Basic usage of the ServiceCycle Python SDK.

Run with: SC_API_KEY=sc_... python examples/basic_usage.py
"""

import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from servicecycle import (  # noqa: E402
    AuthenticationError,
    NotFoundError,
    ServiceCycleClient,
    ServiceCycleError,
)


def main() -> None:
    api_key = os.environ.get("SC_API_KEY")
    if not api_key:
        print("Set SC_API_KEY to a key from Settings -> API Keys and re-run.")
        sys.exit(1)

    base_url = os.environ.get("SC_BASE_URL")  # optional override for local/staging
    client = ServiceCycleClient(api_key=api_key, **({"base_url": base_url} if base_url else {}))

    try:
        identity = client.identity.me()
    except AuthenticationError:
        print("That API key was rejected -- check it hasn't been revoked.")
        sys.exit(1)

    print(f"Authenticated as key '{identity['keyName']}' (account {identity['accountId']})")
    print(f"Scopes: {identity['scopes']}")

    # Assets due for maintenance in the next 30 days
    due_before = (date.today() + timedelta(days=30)).isoformat()
    result = client.assets.list(due_before=due_before, limit=10)
    print(f"\n{result['pagination']['total']} assets due within 30 days (showing up to 10):")
    for asset in result["data"]:
        site = asset["site"]["name"] if asset["site"] else "no site"
        print(f"  - {asset['equipmentType']} ({site}) -- governing condition {asset['governingCondition']}")

    # Open deficiencies, worst severity first is the server's default sort
    open_defs = client.deficiencies.list(status="OPEN", limit=5)
    print(f"\n{open_defs['pagination']['total']} open deficiencies (showing up to 5):")
    for d in open_defs["data"]:
        print(f"  - [{d['severity']}] {d['description']}")

    # Arc-flash labels flagged danger (expired study or high incident energy)
    danger = client.arc_flash.list_labels(severity="danger", limit=5)
    print(f"\n{danger['pagination']['total']} danger-severity arc-flash labels (showing up to 5):")
    for label in danger["data"]:
        print(f"  - {label['busName']} -- {label['incidentEnergyCalCm2']} cal/cm^2, PPE cat {label['ppeCategory']}")

    # Example of the auto-paginating iterator -- stop after 3 for the demo
    print("\nFirst 3 contractors via list_all():")
    for i, c in enumerate(client.contractors.list_all()):
        if i >= 3:
            break
        print(f"  - {c['name']}")

    # Example error handling
    try:
        client.assets.get("00000000-0000-0000-0000-000000000000")
    except NotFoundError as e:
        print(f"\nExpected 404 demo: {e.message}")
    except ServiceCycleError as e:
        print(f"\nUnexpected API error {e.status_code}: {e.message}")


if __name__ == "__main__":
    main()
