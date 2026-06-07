// ─────────────────────────────────────────────────────────────────────────────
// download.js — v0.40 Phase 4 shared authenticated-download helper
//
// Used by every "Export view" button across the app. Fetches a URL with the
// bearer token, prefers a server-provided filename (from Content-Disposition)
// over the caller's fallback, and triggers a browser download via an
// invisible <a download> click.
//
// Returns { filename, blob } so callers can chain follow-up behavior — most
// importantly the v0.40 Phase 5 mailto handoff, which needs the filename to
// pre-fill the email body ("Please find attached Contracts-2026-05-20.xlsx").
// ─────────────────────────────────────────────────────────────────────────────

export async function downloadAuthedFile(url, fallbackFilename) {
  const token = localStorage.getItem('lapseiq_token');
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    // Surface a meaningful error to the caller — they'll usually toast it.
    let msg = `Export failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* not JSON, ignore */ }
    throw new Error(msg);
  }

  const blob = await res.blob();

  // Parse filename from Content-Disposition. Server sends:
  //   Content-Disposition: attachment; filename="Contracts-2026-05-20.xlsx"
  // The match supports both quoted and unquoted forms.
  const cd = res.headers.get('content-disposition') || '';
  const m  = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const filename = m ? decodeURIComponent(m[1].replace(/"/g, '')) : fallbackFilename;

  // Trigger browser download via the invisible-anchor trick. All modern browsers
  // save the file to the user's Downloads folder automatically.
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release the object URL on next tick so the click has time to fire.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);

  return { filename, blob };
}
