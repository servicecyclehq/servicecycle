# Key Rotation Runbook — ServiceCycle

**Version:** 2026-06-24  
**Owner:** Dustin (founder / sole operator)  
**Review cadence:** Rotate at minimum annually, or immediately after a suspected compromise.

---

## Keys in scope

| Key | Purpose | Rotation complexity |
|---|---|---|
| `JWT_SECRET` | Signs access + refresh tokens | Zero-downtime (dual-verify window built-in) |
| `MASTER_KEY` | Encrypts all per-account integration secrets + backups + TOTP secrets | Requires data migration |

---

## 1. Rotate `JWT_SECRET` (zero-downtime)

The server has a built-in dual-verify rotation window: set `OLD_JWT_SECRET` alongside `JWT_SECRET` and the server accepts tokens signed with either key until they expire.

**Access token TTL:** 1 hour. **Refresh token TTL:** 30 days.
To invalidate ALL sessions immediately (without waiting for expiry), also bump every user's `tokenEpoch` — see step 6.

### Steps

**Step 1 — Generate a new secret:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```
Copy the output. It will be your new `JWT_SECRET`.

**Step 2 — Open a rotation window on the droplet:**

SSH in and edit `/root/ServiceCycle/.env`:
```bash
# Before:
JWT_SECRET=<current_value>

# After:
OLD_JWT_SECRET=<current_value>
JWT_SECRET=<new_value>
```

**Step 3 — Rebuild the server:**
```bash
docker compose -f /root/ServiceCycle/docker-compose.yml up -d --build server
```

Startup log will print:
```
[startup] OLD_JWT_SECRET is set — running in JWT rotation window (dual-verify on).
```

**Step 4 — Wait for sessions to drain:**

All access tokens signed with the old key expire in 1 hour. After 1 hour, all active users will have silently re-authenticated with the new key.

If you need to invalidate sessions immediately (e.g., suspected compromise), run:
```bash
# Bump tokenEpoch for all users — invalidates ALL outstanding tokens instantly
docker exec -i servicecycle-db psql -U servicecycle -d servicecycle \
  -c "UPDATE users SET \"tokenEpoch\" = \"tokenEpoch\" + 1;"
```

**Step 5 — Close the rotation window:**

Once the 1-hour access-token window has passed (or after step 4), remove `OLD_JWT_SECRET` from `.env`:
```bash
# Remove the OLD_JWT_SECRET line, then rebuild:
docker compose -f /root/ServiceCycle/docker-compose.yml up -d --build server
```

**Step 6 — Verify:**
```bash
curl -sf http://localhost:3002/api/health
```
Server must return `{"success":true,...}`. If it fails, check that `JWT_SECRET` is present and at least 32 characters.

---

## 2. Rotate `MASTER_KEY`

`MASTER_KEY` is used to derive per-document AES-256 keys (HKDF) and to encrypt backups. There is **no dual-verify window** for this key — rotation requires a data migration to re-encrypt all protected data with the new key.

⚠️ **Do this during a maintenance window.** The migration step is a full table scan; on a large dataset it may take several minutes. The server should be stopped during migration to prevent new writes under the old key.

### What is encrypted with `MASTER_KEY`

1. Per-account integration secrets: AI API keys, webhook signing secrets (`EncryptedAccountSetting` rows where `encrypted = true`)
2. TOTP secrets (`User.totpSecret`, stored as AES-256-GCM ciphertext)
3. Nightly database backups (backup blobs on disk/S3)

### Steps

**Step 1 — Generate a new 32-byte key:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
The output must be exactly 44 characters (32 bytes, base64-encoded). Save it securely.

**Step 2 — Stop the server:**
```bash
docker compose -f /root/ServiceCycle/docker-compose.yml stop server
```

**Step 3 — Take a pre-rotation backup:**
```bash
docker exec servicecycle-db pg_dump -U servicecycle -d servicecycle \
  | gzip > /root/pre-rotation-$(date +%Y%m%d-%H%M%S).sql.gz
```

**Step 4 — Run the re-encryption migration:**

There is currently no automated re-encryption script. The process is:

1. Write a one-off Node script that:
   - Reads every `AccountSetting` row where `encrypted = true`
   - Decrypts the value using the OLD `MASTER_KEY` (via `lib/docCrypto.decryptDocument`)
   - Re-encrypts with the NEW `MASTER_KEY`
   - Writes the new ciphertext back
2. Repeat for `User.totpSecret` (base64 AES-GCM blob).
3. Run the script with both keys available as env vars (`OLD_MASTER_KEY` + `MASTER_KEY`).

> **Note:** `lib/docCrypto.ts` uses HKDF with the document's UUID as the salt, so the derivation is deterministic given the master key — re-encryption is a straightforward decrypt-then-encrypt loop.

**Step 5 — Update `.env` with the new key:**
```bash
MASTER_KEY=<new_44_char_base64_value>
```
Remove `OLD_MASTER_KEY` if you added it.

**Step 6 — Restart the server:**
```bash
docker compose -f /root/ServiceCycle/docker-compose.yml up -d server
```

**Step 7 — Verify:**
```bash
curl -sf http://localhost:3002/api/health
# Then log in and verify you can still read integration settings in the UI
# (they decrypt transparently — if they show garbled text, the migration failed)
```

**Step 8 — Rotate backups:**

Existing encrypted backups on disk/S3 were encrypted with the old `MASTER_KEY`. They can still be decrypted using the old key (keep it in a vault). New backups will use the new key automatically.

---

## 3. When to rotate

| Trigger | `JWT_SECRET` | `MASTER_KEY` |
|---|---|---|
| Annual rotation | Yes | Yes (maintenance window required) |
| Suspected token compromise / session hijack | Yes (immediate) | No |
| Suspected database breach | Yes | Yes (all encrypted data may be exposed) |
| Droplet / `.env` file access by unauthorized party | Yes | Yes |
| Staff departure with `.env` access | Yes | Yes |
| Third-party integration key leak | No | No (rotate the affected API key in that service) |

---

## 4. Key storage and access

- **Current keys:** `/root/ServiceCycle/.env` on the droplet (restricted to root)
- **Backup copies:** Store in a password manager (1Password, Bitwarden) under a "ServiceCycle — production secrets" entry
- **Offsite backup decryption:** The old `MASTER_KEY` must be retained as long as encrypted backup archives exist — store it separately from the current key

---

## See also

- `docs/INCIDENT_RESPONSE.md` — Phase 4 (Eradicate) covers key rotation in the context of a security incident
- `server/lib/docCrypto.ts` — HKDF derivation + verification mechanic
- `server/lib/backupCrypto.ts` — Backup encryption using `MASTER_KEY`
