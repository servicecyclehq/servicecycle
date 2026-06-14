# server/data/help

Generated artifacts that ship inside the lapseiq-server docker image.
Source of truth: `docs/help/*.md` at the repo root. Re-sync after every
edit via `npm run help:sync`. Commit the synced files alongside source.

The `.txt` extension dodges the `*.md` exclude in `server/.dockerignore`
without weakening the rule for stray notes elsewhere in the build context.
