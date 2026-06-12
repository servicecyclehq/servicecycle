// Tiny in-memory hand-off so the "Add data" door (gem W2) can pass a dropped
// file to the right importer page without the user re-selecting it. Module
// singleton; consumed once on the target page's mount.
let _file = null;
export function setPendingImport(file) { _file = file; }
export function takePendingImport() { const f = _file; _file = null; return f; }
