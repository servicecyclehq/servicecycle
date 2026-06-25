# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email your report to **security@servicecycle.app**. Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (or proof-of-concept)
- Affected versions or endpoints
- Any suggested mitigations

We will acknowledge receipt within **2 business days** and aim to provide a
status update (confirmed / not reproducible / fix timeline) within **7 days**.

## Disclosure window

We follow a **90-day coordinated disclosure** policy. We ask that you give us
90 days from the date of acknowledgment to ship a fix before public disclosure.
We will work with you on an earlier timeline if circumstances warrant it.

## Scope

In scope:

- The ServiceCycle hosted application (`servicecycle.app`) and its API
- Authentication and authorization bypasses, tenant isolation failures
- Data exposure (cross-account data access, PII leakage)
- Injection vulnerabilities (SQL injection, command injection, XSS)
- Cryptographic weaknesses in the audit chain or document hash pipeline
- Arc-flash label or energized-work permit data integrity issues

Out of scope:

- Vulnerabilities in third-party dependencies that do not affect ServiceCycle
  specifically (report those to the upstream maintainer)
- Social engineering, physical attacks, or attacks requiring admin access you
  already legitimately hold
- Rate-limit bypass where the bypass does not expose protected data
- Findings from automated scanners without a demonstrated exploitability path

## Safe harbor

We commit not to pursue legal action against researchers who:

- Act in good faith and follow this policy
- Do not access, modify, or exfiltrate data beyond what is necessary to
  demonstrate the vulnerability
- Do not disrupt production service availability

## Acknowledgments

We will publicly acknowledge the reporter's contribution (with their consent)
once the fix is shipped.
