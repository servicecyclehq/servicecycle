// Tiny in-memory hand-off so the "Add data" door (gem W2) can pass a dropped
// file to the right importer page without the user re-selecting it. Module
// singleton; consumed once on the target page's mount.
//
// 2026-07-13: added an optional metadata hint alongside the file (e.g. which
// arc-flash sourceType to pre-select) -- backward compatible, existing
// setPendingImport(file)/takePendingImport() callers are unaffected.
let _file = null;
let _meta = null;
export function setPendingImport(file, meta = null) { _file = file; _meta = meta; }
export function takePendingImport() { const f = _file; _file = null; return f; }
export function takePendingImportMeta() { const m = _meta; _meta = null; return m; }
