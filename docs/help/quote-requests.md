# Quote Requests

A quote request is how a facility team asks their electrical contractor for a
repair, replacement, or inspection quote — without picking up the phone. The
request travels from the asset page directly into the contractor's Sales inbox,
carrying the full asset dossier so the rep has everything they need to quote
accurately.

## What you'll see

**From the asset:** the "Request a quote" button appears on any asset where you
have write access. Click it to open the guided form. The app pre-fills the asset
context (nameplate, open deficiencies, overdue tasks, downstream impact) and asks
you to describe the urgency, timeline, and whether the asset can be taken offline.

**From the operator's Sales inbox** (Sidebar → Sales, visible to operator staff):
every open request, sorted by priority — emergencies at the top, then high, normal,
and low. The rep can view the full dossier, quote a price, or decline with a reason.

**Status chips** on the asset and in the inbox track the request through its
lifecycle: **Requested → Quoted → Accepted / Declined**.

## Request drivers

The driver is the underlying reason for the request. It determines the automatic
priority that lands in the inbox.

- **Down now** — asset is out of service and must be restored immediately.
  Auto-classified as *Emergency*; the form flags it prominently.
- **Suspected failing** — signs of degradation that have not yet caused a
  shutdown. Auto-classified as *High*.
- **Failed inspection** — a deficiency found during an audit or NETA test that
  requires remediation before re-energizing.
- **Planned replacement** — end-of-life or modernization-driven swap on a
  defined schedule.
- **Budgetary / study** — no immediate need; gathering pricing for the capital
  plan or an upcoming arc-flash / short-circuit study.

## Emergency mode

When the driver is **Down now**, the request enters emergency mode. The form adds
fields for outage availability and window, and the inbox displays a prominent
emergency banner. Emergency requests always land at the top of the queue regardless
of when they were submitted.

## Common workflows

**"Request a quote on an asset."** Open the asset → Request a quote → choose a
driver, timeline, and whether the asset can be de-energized → Submit.

**"Check the status of a request I submitted."** The status chip on the asset card
updates as the rep acts on it. You can also see all your account's open requests
from the asset list by filtering on open quote requests.

**"Quote a request (operator staff)."** Sidebar → Sales → open the request →
enter quote notes → Accept (or Decline with a reason). Accepting stamps the
resolved date and links any follow-on work order.

**"See which requests have been resolved."** The Sales inbox has a Resolved tab
showing all accepted and declined requests in the last 90 days.

## When something looks wrong

**The "Request a quote" button is not visible.** You may not have write access to
that asset, or the operator has not enabled the quote-request feature on your
account. Contact your admin.

**A request I submitted shows no response after several days.** The operator's
inbox is sorted by priority. Low-priority or budgetary requests may sit behind
higher-priority work. Contact your rep directly if it is urgent and let them know
to look for the request in ServiceCycle.

**The accepted request did not create a work order.** Work orders linked to quote
requests are created by the operator after acceptance. Ask your rep to open a
work order from the accepted request in their Sales inbox.
