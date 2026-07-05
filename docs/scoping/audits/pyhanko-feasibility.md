# pyHanko Feasibility Check (PDF Digital Signing/Verification)

**Date:** 2026-07-05
**Scope:** Feasibility-only check of whether `pyHanko` (Python PDF digital signature library, for signing/verifying PE-stamped engineering reports) can be added as a future dependency of ServiceCycle's Python sidecar (`server/pyextract`). No production files were touched — this was tested entirely in a throwaway Linux virtualenv, created and destroyed inside the bash sandbox.

## What Was Checked

1. Clean install of `pyhanko` into a fresh venv (`python3 -m venv` + `pip install pyhanko`), on Python 3.10.12 (Debian-based sandbox, comparable manylinux wheel availability to the prod `node:20-slim` image's Python).
2. Import sanity check: `import pyhanko; from pyhanko.sign import signers`.
3. pyHanko's and `pyhanko-certvalidator`'s trust-store behavior for signature verification, read directly from the installed package source (`ValidationContext.__init__` docstring in `pyhanko_certvalidator/context.py`) and from `oscrypto`'s trust-list module — no guessing needed, the library is explicit about this in its own code.
4. `cryptography` version constraints declared by pyHanko, cross-checked against a second throwaway venv containing ServiceCycle's actual pinned `server/pyextract/requirements.txt` stack (`pdfplumber==0.11.4`, `pypdf==4.3.1`, `pytesseract==0.3.13`, `Pillow>=10.4.0,<12.0`), then pyHanko installed on top of that same venv and validated with `pip check`.
5. Site-packages size measured for pyHanko alone, for the existing SC pyextract baseline alone, and for both combined, to isolate the true incremental delta.

All venvs (`/tmp/pyhanko_test`, `/tmp/sc_check`, `/tmp/sc_baseline`) were deleted at the end of the session. `server/pyextract/requirements.txt` was read-only (Read tool) and was never modified.

## Install Result

**Success.** `pip install pyhanko` completed cleanly with no build-from-source steps — every dependency resolved to a prebuilt manylinux/pure-Python wheel (matches the `node:20-slim`/Debian-glibc runtime target noted in ServiceCycle's requirements.txt comments).

- **Version installed:** `pyHanko 0.35.1` (latest as of 2026-07-05)
- **Import check:** `import pyhanko; from pyhanko.sign import signers` → succeeded with no errors or warnings. (Note: `pyhanko.__version__` is *not* a valid top-level attribute — use `importlib.metadata.version('pyHanko')` instead, which correctly returned `0.35.1`.)
- **Dependencies pulled in (pyHanko alone, `pip freeze`):**
  ```
  asn1crypto==1.5.1
  certifi==2026.6.17
  cffi==2.0.0
  charset-normalizer==3.4.7
  cryptography==49.0.0
  idna==3.18
  lxml==6.1.1
  oscrypto==1.3.0
  pycparser==3.0
  pyHanko==0.35.1
  pyhanko-certvalidator==0.31.1
  PyYAML==6.0.3
  requests==2.34.2
  typing_extensions==4.16.0
  tzlocal==5.4.4
  uritools==6.1.2
  urllib3==2.7.0
  ```
- **Site-packages size (pyHanko's own fresh venv, includes pip/setuptools bootstrap):** 59 MB total; 43 MB excluding `pip`/`setuptools`/`pkg_resources` (which aren't shipped in a production image layer); ~38.4 MB of genuinely runtime-relevant package weight. Largest contributors: `cryptography` (15 MB), `lxml` (12 MB), `pyhanko` itself (3.6 MB), `yaml` (2.9 MB), `oscrypto` (1.8 MB).

## Trust Store Behavior

pyHanko delegates all certificate-chain trust decisions to its sister library `pyhanko-certvalidator`, via a `ValidationContext` object. This is explicit and documented directly in the installed source (`pyhanko_certvalidator/context.py`, `ValidationContext.__init__` docstring):

- **Default behavior (no `trust_roots` passed):** falls back to **the operating system's trust list**. On Linux this is implemented through `oscrypto`'s `_linux_bsd.trust_list` module, which reads the system CA bundle (typically `/etc/ssl/certs/ca-certificates.crt` on Debian — the same distro as ServiceCycle's `node:20-slim` runtime image).
- **`trust_roots=[...]`:** caller supplies an explicit list of DER/PEM certs or `TrustAnchor` objects; OS trust list is bypassed entirely.
- **`extra_trust_roots=[...]`:** OS trust list is used *and* augmented with caller-supplied certs (e.g., to add a private/internal CA or a specific PE-licensing-board CA on top of the system defaults).
- Revocation checking (`revocation_mode`) defaults to `"soft-fail"` — CRL/OCSP fetch failures are silently ignored unless the caller opts into `"hard-fail"` or `"require"`. `allow_fetching=False` by default, meaning **no live network calls happen unless explicitly enabled** — a caller-supplied `ValidationContext` is needed to do real-time revocation checking against issuing CAs.

**Bottom line:** pyHanko does **not** bundle its own private trust-root list (it is not a "batteries-included" CA bundle like `certifi`). It relies on the OS trust store by default, but exposes a clean API for ServiceCycle to supply its own restricted trust context (e.g., a specific state licensing-board root or a customer-supplied internal CA) — which is likely the more correct behavior for a PE-stamp verification feature, since "does this chain to any of the world's public CAs" is the wrong question; "does this chain to a specific engineer's signing cert/CA" is the right one. This was verified directly from source/docstrings, not guessed — no live network verification test was needed to determine this.

## Dependency Conflict Check: **Compatible**

`server/pyextract/requirements.txt` currently pins:
```
pdfplumber==0.11.4
pypdf==4.3.1
pytesseract==0.3.13
Pillow>=10.4.0,<12.0
```
It has **no explicit `cryptography` pin**. However, testing revealed `cryptography` is *already* a transitive dependency of the existing stack: `pdfplumber` → `pdfminer.six` → `cryptography>=36.0.0` (used for decrypting password-protected PDFs). In the baseline venv this resolved to `cryptography==49.0.0`.

pyHanko requires `cryptography>=48.0.0`. Installing pyHanko into a venv that already had the full SC pyextract stack:
- Resolved to the **same** `cryptography==49.0.0` (no downgrade/upgrade needed, no duplicate install).
- `pip check` afterward reported **"No broken requirements found."**
- No other SC-pinned package (`pypdf`, `pytesseract`, `Pillow`, `pypdfium2`) depends on `cryptography`, `lxml`, `pyyaml`, or `requests`, so there's no secondary collision surface either.

**Verdict: compatible, not conflicting.** The version ranges happen to overlap comfortably (`>=36.0.0` and `>=48.0.0` both satisfied by 49.0.0), and since ServiceCycle doesn't pin `cryptography` explicitly today, adding pyHanko wouldn't require touching the existing pin at all — it would just add a `pyhanko==0.35.1` (or similar) line. The only mild future risk: if pyHanko's `cryptography>=48.0.0` floor rises further and outpaces whatever `pdfminer.six` supports, a resolver conflict could appear later — worth re-running `pip check` at upgrade time, not a reason to hold off now.

## Size Delta Estimate

Measured directly by diffing two throwaway venvs (existing SC pyextract stack alone vs. same stack + pyHanko):

- **SC pyextract baseline site-packages:** 72.0 MB
- **SC pyextract + pyHanko combined:** 94.5 MB
- **Net incremental delta from adding pyHanko:** **~22.5 MB** of site-packages weight (this is smaller than pyHanko's fresh-venv footprint of ~38 MB because `cryptography`, `cffi`, `charset-normalizer`, `typing_extensions`, etc. are already present as `pdfminer.six`/`pdfplumber` transitive deps and are shared, not duplicated).
- On the actual Docker image this delta would be somewhat different (Debian system package layer, wheel vs. sdist caching, compiled `.so` stripping), but **~20–25 MB added to the image** is a reasonable estimate — small relative to a typical Node+Python hybrid image, and dwarfed by Tesseract/OpenCV-class dependencies if those are ever added.

## Recommendation: **Lazy-load later, do not bundle now**

Reasoning:

1. **No current caller.** The PE-stamp/EDMS signing feature has not shipped and isn't on the immediate roadmap (per the memory index, EDMS scoping is parked/deferred behind APS/ODA licensing questions, and PE-seal verification isn't in the "next 3" ranked items). Adding a dependency with zero call sites today is pure carrying cost with no product benefit yet — it thickens the image, adds to the CVE-scanning/SBOM surface (relevant given the active SOC 2 posture — every new package is one more thing gitleaks/trivy/SBOM tooling has to track), and adds a `pyhanko-certvalidator` version ceiling (`<0.32`) that could theoretically start drifting stale before it's ever used.
2. **Genuinely low risk to add later.** This test proves there's no landmine waiting: install is clean, wheels are prebuilt (no compiler toolchain needed in the Docker build), `cryptography` version ranges already overlap with zero pin changes required, and the size cost (~20-25 MB) is modest. There's no reason to front-load that cost before the feature exists.
3. **Trust-context design work should happen at feature-build time, not now.** Since pyHanko doesn't bundle PE-licensing-board CAs (nothing does — that's a real-world PKI problem, not a library gap), the actual engineering work here isn't "pip install a package," it's "figure out whose trust roots to hand `ValidationContext`." That's a design conversation to have when the EDMS/PE-seal feature is actually scoped, not something this feasibility check should pre-decide.
4. **When it does ship:** add `pyhanko` (pin the exact version tested, `0.35.1`, or whatever is current then) as its own line in `server/pyextract/requirements.txt` alongside a re-run of `pip check` in CI, and treat the trust-root question (OS store vs. explicit `extra_trust_roots` for a specific licensing-board/CA) as a first-class design decision in that feature's spec — not an implementation detail.

**One-line summary:** pyHanko installs clean, imports clean, and is dependency-compatible with the existing pyextract stack today — but since there's no shipping feature that needs it yet, defer bundling it until the PE-seal/EDMS signing work is actually scheduled.
