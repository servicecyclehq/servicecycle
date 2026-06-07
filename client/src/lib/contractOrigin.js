// #4 contract-section-refresh: contract <-> vendor round-trip origin context.
//
// When the user clicks through from a contract to one of its vendors, we stash
// where they came from -- the full contract URL (including ?tab=), the scroll
// position, and a human-readable label -- so the vendor page can render a
// persistent "Back to [contract]" link that returns to the EXACT contract +
// tab + section + scroll.
//
// Mirrors the lapseiq_last_contracts_url + router-state pattern used by the
// Contracts back-link: the origin is passed through react-router `state` (so it
// survives in-app navigation) AND mirrored to sessionStorage (so it survives a
// hard reload of the vendor page, and is recoverable if router state is lost).

const KEY = 'lapseiq_contract_origin';

// Capture the current contract location as an origin object. Call at CLICK time
// so window.scrollY reflects where the user actually is on the page (not where
// they were at render).
export function buildContractOrigin(label) {
  return {
    url: window.location.pathname + window.location.search,
    scrollY: typeof window !== 'undefined' ? (window.scrollY || 0) : 0,
    label: label || 'contract',
  };
}

export function rememberContractOrigin(origin) {
  try { sessionStorage.setItem(KEY, JSON.stringify(origin)); } catch (e) {}
}

// Prefer the router-state origin (most reliable for the click that just
// happened); fall back to the sessionStorage mirror on a hard reload.
export function readContractOrigin(stateOrigin) {
  if (stateOrigin && stateOrigin.url) return stateOrigin;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.url) return parsed;
    }
  } catch (e) {}
  return null;
}

export function clearContractOrigin() {
  try { sessionStorage.removeItem(KEY); } catch (e) {}
}
