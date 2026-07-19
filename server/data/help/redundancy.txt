# Redundancy Impact

A redundant power system exists so you can take part of it offline — for
maintenance, or when something fails — without going dark. The **Redundancy impact**
panel answers the question that matters when you're planning that work: *if I drop
this side, or this source, what actually keeps running, what loses its backup, and
what goes dark?* It reads your system topology and shows you, before you throw the
switch.

> Read-only, and no engineering math. This is a system-of-record view built from the
> feed graph you've confirmed — it counts independent source paths, it does not
> perform a power-flow or protection study. Use it to plan and to sanity-check
> redundancy claims, not as a substitute for an engineered analysis.

## Where it lives

On a site's detail page, in the **System Studies** card (shown when arc-flash
studies are enabled for the account), below the one-line import panel. It uses the
multi-source topology built from your one-line import — so it's most useful on a 2N
or N+1 site whose feed graph has been confirmed.

## How to use it

Pick what to take offline and press **Show impact**:

- **Drop side A** or **Drop side B** — take an entire distribution side offline (the
  common concurrent-maintenance question on a 2N site). Dropping side B is the
  default.
- **…or drop a specific source** — pick a single source asset (a utility service,
  generator, UPS, transformer, switchgear) from the list to model losing just that
  one.

## Reading the result

Every downstream load lands in one of three states, counted by how many
**independent, durable source paths** it still has:

- **Retained** (≥ 2 paths) — still redundant. Losing one more source wouldn't drop
  it either.
- **At risk** (1 path) — still powered, but its redundancy is gone. It's now on a
  single source (or on battery ride-through only, with no durable source behind it).
- **Dropped** (0 paths) — no source path remains. This load goes dark.

The headline verdict tells you whether the site is **concurrent-maintainable** for
that scenario — i.e. whether you can take the chosen side or source down for
maintenance with **no** load going dark. The affected-loads table lists each load,
its state, its durable-path count (with the baseline shown when it changed), and a
plain note like *"Redundancy lost — single source"* or *"No source path remains."*

## Making it accurate

The analysis is only as good as the topology behind it. When a site's AssetFeed
edges — which sources feed which loads, on which side — are fully tagged, the result
is exact. When they aren't, ServiceCycle falls back to the primary feed tree and
tells you so, with a note to tag the A/B sides and source kinds (via the one-line
import) for full multi-source accuracy. If a result looks off, that's usually the
first thing to check.

## Common workflows

**"Can I take side B down for maintenance without dropping anything?"** Drop side B,
Show impact — if the verdict is concurrent-maintainable and nothing is in the
Dropped column, you're clear.

**"What loses redundancy if this generator is out?"** Pick the generator from the
specific-source list and Show impact; the At-risk column is everything that falls to
a single source.

**"Which load is the weak point?"** Anything in the Dropped or At-risk column on a
single-source drop is where your redundancy is thinnest — the place to look first
when planning upgrades.

## When something looks wrong

**A load shows as Dropped on a site I thought was redundant.** Most often the feed
graph isn't fully tagged, so the analysis fell back to the primary feed tree — check
for the fallback note, and tag the multi-source edges via the one-line import for an
accurate picture.

**No loads are listed.** No loads are modeled for the site yet. Tag the IT racks and
mechanical loads and their feeds (the AssetFeed topology, built by confirming a
one-line import) and they'll appear here.

**The numbers don't match my one-line.** Confirm the topology was actually persisted
— the redundancy graph only reflects feeds you've confirmed on the one-line import
panel, not a draft you haven't confirmed yet.
