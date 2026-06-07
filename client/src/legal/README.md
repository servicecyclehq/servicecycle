# client/src/legal

Generated copies of the canonical legal documents that live at
`/legal/` in the repo root. Synced via `npm run legal:sync` from the
client directory. Do NOT edit these files directly — edits will be
overwritten by the next sync. Author the documents in `/legal/` and
run the sync script before committing.

These copies exist so vite/rollup can resolve the markdown imports
when the docker build context is `./client` only (the canonical
`legal/` folder is outside that context). Local dev builds don't
need this — vite has access to the full repo tree.
