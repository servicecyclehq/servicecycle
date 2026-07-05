"""Auto-paginating iterator helper. Mirrors sdk/src/paginator.ts."""

from __future__ import annotations

from typing import Any, Callable, Dict, Iterator


def paginate(fetcher: Callable[[Dict[str, Any]], Dict[str, Any]], params: Dict[str, Any]) -> Iterator[Any]:
    """Yield items across all pages of a `{data, pagination}` list endpoint.

    Example::

        for asset in client.assets.list_all(limit=100):
            print(asset["id"])
    """
    page = params.get("page") or 1
    limit = params.get("limit") or 50
    while True:
        result = fetcher({**params, "page": page, "limit": limit})
        for item in result["data"]:
            yield item
        pagination = result["pagination"]
        if page >= pagination["pages"]:
            break
        page += 1
