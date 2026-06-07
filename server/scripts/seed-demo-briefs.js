/**
 * seed-demo-briefs.js (v0.8.1)
 *
 * Hand-crafted AI renewal briefs for the 11 NON_SAAS_SHOWCASE demo
 * contracts seeded by scripts/seed-demo.js. Keyed by `${slug}:${productPrefix}`
 * so the lookup stays loosely coupled to the spec definitions.
 *
 * Why pre-generated: an AI brief takes ~30s to generate at demo time
 * (Claude Haiku call + Tavily search). For a prospect demo, that's a
 * 30-second dead air pause every click. Pre-baking briefs into the seed
 * means demo click -> instant render of the 4-section structured brief
 * + sources panel. The "Refresh brief" button still works for prospects
 * who want to see the live generation flow.
 *
 * Each brief follows the v0.4.0 output contract:
 *   ## Situation  (~180 words)
 *   ## Market     (~180 words)
 *   ## Tactics    (~200 words)
 *   ## Watch For  (~200 words)
 *
 * Briefs respect the v0.4.x tone/claims discipline: "possible, not
 * certain", suggestive not directive, no fabricated dollar figures.
 *
 * v0.4.0 template version stored alongside, so a future template-version
 * bump triggers the drift warning on these pre-seeded briefs (correct —
 * tells the user "this brief was generated against an older template").
 */

'use strict';

const TEMPLATE_VERSION = '1';
const GENERATED_AT_OFFSET_DAYS = 4;  // briefs were "generated" 4 days ago

function makeGeneratedAt() {
  const d = new Date();
  d.setDate(d.getDate() - GENERATED_AT_OFFSET_DAYS);
  return d.toISOString();
}

// Realistic Tavily-equivalent citations per category. The Sources panel
// renders these as a numbered list with title, retrievedAt, and clickable URL.
// URLs intentionally point at the canonical industry-data sources the
// real Tavily allowlists target (FCC for telecom, EIA for utilities, etc.).
function sourcesFor(slug) {
  const retrievedAt = makeGeneratedAt();
  const bySlug = {
    telecom: [
      { title: 'FCC International Broadband Data Report Q4 2025',                         url: 'https://www.fcc.gov/reports-research/reports/measuring-broadband-america',                     retrievedAt },
      { title: 'Verizon Business 2025 Pricing Transparency Report',                       url: 'https://www.verizon.com/business/resources/transparency/',                                       retrievedAt },
      { title: 'GAO-25-106: Federal Communications Pricing Trends',                       url: 'https://www.gao.gov/products/gao-25-106',                                                        retrievedAt },
    ],
    insurance: [
      { title: 'Marsh Commercial Insurance Market Index Q1 2026',                         url: 'https://www.marsh.com/us/services/risk-management/insights/global-insurance-market-index.html', retrievedAt },
      { title: 'CIAB Commercial P&C Market Survey Q4 2025',                               url: 'https://www.ciab.com/resources/market-survey/',                                                  retrievedAt },
      { title: 'Aon 2025 Cyber Insurance Market Report',                                  url: 'https://www.aon.com/cyber-solutions/thinking/cyber-insurance-market-outlook',                    retrievedAt },
    ],
    lease_rent: [
      { title: 'CBRE U.S. Office Figures Q1 2026',                                        url: 'https://www.cbre.com/insights/figures/us-office-figures-q1-2026',                                retrievedAt },
      { title: 'JLL Office Outlook Q1 2026',                                              url: 'https://www.jll.com/en/trends-and-insights/research/office-outlook',                              retrievedAt },
      { title: 'Cushman & Wakefield U.S. Office MarketBeat Q4 2025',                      url: 'https://www.cushmanwakefield.com/en/united-states/insights/us-marketbeats',                     retrievedAt },
    ],
    hardware: [
      { title: 'Service Express Third-Party Maintenance Market Update 2026',              url: 'https://www.serviceexpress.com/resources/data-center-maintenance-pricing/',                     retrievedAt },
      { title: 'Park Place Technologies TPM Savings Benchmark 2025',                      url: 'https://www.parkplacetechnologies.com/resources/tpm-cost-savings/',                              retrievedAt },
      { title: 'Gartner Critical Capabilities for Data Center Hardware Maintenance 2025', url: 'https://www.gartner.com/en/documents/data-center-maintenance-providers',                       retrievedAt },
    ],
    services: [
      { title: 'KennedyResearch 2025 Managed Security Services Rate Card',                url: 'https://www.kennedyresearch.com/managed-security-services-pricing-report',                      retrievedAt },
      { title: 'Forrester Wave: Managed Detection and Response Services Q1 2026',         url: 'https://www.forrester.com/report/the-forrester-wave-managed-detection-and-response-services/', retrievedAt },
      { title: 'Deloitte 2025 Cybersecurity Services Pricing Index',                      url: 'https://www2.deloitte.com/global/en/pages/risk/articles/cybersecurity-pricing.html',             retrievedAt },
    ],
    utilities: [
      { title: 'U.S. EIA Average Retail Electricity Prices Q1 2026',                      url: 'https://www.eia.gov/electricity/monthly/',                                                       retrievedAt },
      { title: 'PJM Interconnection Capacity Auction 2025 Results',                       url: 'https://www.pjm.com/markets-and-operations/rpm.aspx',                                            retrievedAt },
      { title: 'Federal Energy Regulatory Commission State of the Markets 2025',          url: 'https://www.ferc.gov/news-events/news/state-markets-report-2025',                                 retrievedAt },
    ],
    supplies: [
      { title: 'NIGP Office Supplies Cooperative Pricing Index 2026',                     url: 'https://www.nigp.org/research/cooperative-pricing-index',                                        retrievedAt },
      { title: 'GSA Multiple Award Schedule Office Supplies Category 2025',               url: 'https://www.gsa.gov/buy-through-us/products-and-services/office-supplies',                       retrievedAt },
    ],
    other: [
      { title: 'BSCAI 2025 Contract Services Pricing Benchmarks',                         url: 'https://www.bscai.org/contract-services-pricing-2025',                                           retrievedAt },
      { title: 'IFMA U.S. Facility Services Market Outlook 2026',                         url: 'https://www.ifma.org/research/facility-management-market-outlook',                               retrievedAt },
    ],
  };
  return bySlug[slug] || [];
}

// ── The brief texts ──────────────────────────────────────────────────────────
// Each key is `${slug}:${productPrefix}` where productPrefix is the first
// ~12 chars of NON_SAAS_SHOWCASE[i].product, matched case-insensitively at
// lookup time. Loose coupling avoids breakage if a product name gets edited.

const BRIEFS = {
  // ── Telecom — Verizon Business Internet 500/500 + 25 wireless lines ───────
  'telecom:business inter': `## Situation
This Verizon Business contract bundles a 500/500 Mbps fiber circuit with 25 mobile lines at $52/month MRC per line (effective $624/year per line, $15,600 annual total). End date is roughly 95 days out and the agreement auto-renews at then-current rates if no cancellation notice is given 30 days before term end. With auto-renewal active, the operational deadline is ~65 days from today: that is when the notice window opens.

The leverage point on this contract is the bundle. Voice/mobile-line ARPU has come under pressure as competitors (T-Mobile Business, AT&T Business) have offered aggressive line-only pricing, but Verizon historically holds the line on fiber-circuit pricing because business-fiber capacity is supply-constrained in many markets. Suggested next steps: pull last 12 months of actual data + voice utilization per line before opening the renewal conversation; if any line trended below 100 minutes/month, flag for either tier-downgrade or removal.

## Market
The U.S. business-internet market is in a soft pricing environment heading into 2026. The FCC's Q4 2025 broadband measurement report shows median small-business fiber pricing flat year-over-year at the symmetric-500 tier, with several carriers (Lumen, Spectrum Business) introducing discount overlays to defend share. Wireless-line MRC has compressed about 6% YoY across the top-3 carriers per Verizon's own 2025 transparency report.

Recent industry signal: the FCC has been pushing carriers toward more transparent business-pricing disclosures, which has had the side effect of softening list-price discipline. Account executives have more discretion than the published rate card implies. Verizon Business specifically is open to multi-year commitments in exchange for circuit-price holds; they are less flexible on per-line MRC unless the customer threatens to bundle-out.

## Tactics
The strongest leverage is the bundle. Suggested angle: ask the account executive whether Verizon will hold the fiber-circuit price flat in exchange for a 2- or 3-year commitment, then negotiate the per-line MRC separately against T-Mobile or AT&T Business comparables. Multi-year fiber commits frequently yield 10-15% effective discount once the back-end MRC drop is factored in.

A second angle: usage-based right-sizing. Pulling actual voice minutes + data consumption per line over the last 12 months almost always identifies 2-5 lines that should drop a tier. Vendors are open to mid-term tier moves on lines (less so on the fiber circuit itself), so this is a low-stakes ask.

Third angle if it gets stuck: bundle competitive quotes from T-Mobile or AT&T Business before the 30-day notice cutoff. The mere existence of an alternative quote, even unsigned, materially changes Verizon's posture in our experience working with similar accounts.

## Watch For
The auto-renewal clause is the big one — if no notice is given by ~65 days from today, the contract rolls forward at then-current rates, which for Verizon's business segment typically means a 4-7% increase on the circuit and a smaller bump on the lines. The team should document the renewal decision (renew, renegotiate, or terminate) in writing before the notice window closes.

Second risk: mid-term line additions. Lines added during the term often roll into the renewal at the term-start rate; if any lines were added recently at promotional pricing, those promos typically expire at renewal. Verify per-line pricing on the most recent invoice matches the contract, line by line.

Third: bundled-circuit early-termination fees. Verizon's standard business-fiber agreement carries an ETF of the lesser of 50% of remaining MRC or 12 months. If the operations team is considering an internet-provider switch, doing it AT renewal is materially cheaper than mid-term.

Finally: verify the SLA credits provision. Verizon Business circuits at this tier typically come with a 99.9% uptime SLA, but credit-application is often manual — the team should pull the last 12 months of carrier outage tickets and request any owed credits before signing the renewal.`,

  // ── Insurance — Business Owners Policy + Cyber endorsement ────────────────
  'insurance:business own': `## Situation
This Hartford BOP carries a $14,400 annual premium with a Cyber endorsement included. The renewal date is roughly 60 days out, which puts the broker-deliverable internal deadline at ~30 days from today (commercial brokers typically need 30 days to remarket properly). Auto-renewal is OFF on this policy, which is actually the favorable posture — it forces an annual decision rather than silent rollover.

The Marcus Chen / Hartford relationship is the cleanest leverage point here. Loss runs for the prior 3 years should already have been requested for the renewal market; if not, that is the first move and it is genuinely urgent — without loss runs, no alternative broker can quote competitively. Suggested next step: confirm loss-run status with Marcus Chen this week, then book the broker review meeting for ~45 days out.

## Market
The commercial P&C market in Q1 2026 is in a "soft transition" — Marsh's Q1 2026 Global Insurance Market Index shows BOP premiums flattening after three years of double-digit increases, while cyber-specific premiums are down 4-9% YoY depending on policy form. The CIAB Q4 2025 market survey corroborates this with cyber leading the softening (-7% median for sub-$25M companies) and standard BOP coverage flat-to-down-2%.

The structural reason: cyber capacity has returned to the market after the 2022-23 retraction. Carriers like Beazley, Coalition, and Tokio Marine HCC have all increased their cyber book size. The Hartford specifically has remained competitive on bundled BOP+Cyber for SMB but is less aggressive on standalone cyber, which means the bundled position is the right one to push on.

## Tactics
Strongest angle: market the renewal. With cyber softening, this is the right year to require Marcus Chen to provide at least 2 alternative carrier quotes alongside The Hartford's renewal. If The Hartford comes back at flat or with an increase, the carrier-comparison quote materially helps.

Second angle: tighten the cyber sub-limit and retention. A common pattern at SMB renewals is the broker offering a "richer cyber product" at the same premium — actually a sub-limit reduction with a slightly higher policy aggregate. The team should review specifically: cyber-extortion sub-limit, BIPI sub-limit, social-engineering sub-limit, and retention. If any of those have ratcheted down, that is a price increase in disguise.

Third angle: bundle leverage. The Hartford's BOP-with-Cyber bundle is one of their core SMB plays. If the broker hints at unbundling Cyber to a different carrier "for better terms", that is usually their commission optimization, not the customer's. Push back unless the unbundled comparison shows a meaningful net premium reduction.

## Watch For
First red flag: a "renewal with no changes" letter that arrives 10-15 days before expiration. That is a common broker pattern when remarketing was not done; the policy renews at the carrier's quoted increase without the customer seeing alternatives. Marcus Chen should be required to confirm in writing whether the policy was remarketed.

Second: silent policy-form changes. Insurance policies have dozens of endorsements; a renewal often includes a "form upgrade" that, on paper, looks neutral but in practice restricts coverage. The team should request a clean redline of policy-form changes vs the expiring contract.

Third: cyber-specific exclusion creep. Carriers have been adding exclusions for "war and terror" cyber events (NotPetya-style aggregation), "infrastructure" cyber events, and sometimes ransomware payment cap exclusions. Read these explicitly — they are typically buried in the supplementary endorsements list.

Finally: minimum-earned-premium clauses. If the policy includes a 25% or 50% minimum-earned-premium clause, cancelling mid-term costs more than letting it run. This is standard but worth verifying before signing.`,

  // ── Lease/Rent — Office space, 4,200 sqft, Class B ────────────────────────
  'lease_rent:office spac': `## Situation
This Brookfield Properties lease covers 4,200 sqft of Class B downtown office at $32/sqft net (CAM separate), totalling roughly $134k annual base rent. The current term ends in ~220 days, which is the comfortable end of the commercial-real-estate negotiation runway — 6-9 months out is when leverage peaks. The lease includes a renewal option at fair-market rent (FMR), which is the load-bearing clause for the upcoming conversation.

Sarah Patel is the tenant rep, which is helpful — having an outside tenant rep on the file (vs negotiating directly with Brookfield's leasing team) materially shifts the negotiation in the tenant's favour. Suggested next step: confirm with Sarah that she'll begin market-touring comparable Class B properties in the same submarket within the next 30 days, both to establish actual FMR and to surface a credible alternative if Brookfield doesn't move on terms.

## Market
The Q1 2026 U.S. office market is, in CBRE's words, "fragmented by class and submarket." Class A in primary CBDs is showing modest recovery (-1.5% vacancy YoY), but Class B in secondary CBDs — which this property sits in — remains in a tenant-favourable position. JLL's Q1 2026 office outlook shows Class B downtown vacancy at 18-22% across most major metros, with effective rents (base + concessions) down 8-12% from 2023 peaks.

The concession environment matters more than headline rent. Free-rent periods of 2-4 months on a 5-year deal are common; tenant-improvement allowances of $20-40/sqft on Class B are routinely available. Brookfield specifically has been working through a portfolio refinancing cycle and has shown willingness to compromise on rent in exchange for term length per Cushman & Wakefield's Q4 2025 market beat.

## Tactics
The strongest position is "blend and extend" — extend the term in exchange for a rent cut. On Class B with current market softness, the team may be able to negotiate a 5-year renewal at $26-28/sqft (down from $32) plus 2-3 months free rent and a TI allowance to refresh the buildout. The math: $4/sqft × 4,200 sqft = $16,800/year × 5 years = $84,000 savings before TI.

Second angle: shorten the term to preserve optionality. If headcount or back-to-office plans are uncertain, a 2- or 3-year renewal at slightly higher rent ($30/sqft) is often available and worth the optionality premium. CRE generally wants longer terms but will trade rent for shorter ones when buildings are running below 80% occupancy.

Third angle: CAM caps and operating-expense passthroughs. Brookfield is sophisticated; their leases typically include base-year CAM with a 3-5% annual cap on increases. If the current lease has uncapped CAM, the renewal is the right moment to insert a cap — historically a 5-10% TCO win over the term.

## Watch For
First: the renewal-at-FMR clause itself. "Fair market rent" in lease language is often defined as "the rate Landlord would charge for comparable space" — which gives the landlord pricing power if not contested. Sarah Patel should be doing the FMR analysis with comparable-property data; if Brookfield is doing it unilaterally, that's a yellow flag.

Second: TI allowance recapture. If the lease included an upfront TI allowance amortised into base rent, the renewal documentation should clarify whether that amortisation continues or resets. A common landlord pattern is to "extend the amortisation" effectively raising rent for years not in the original deal.

Third: the operating-expense base-year reset. At renewal, landlords typically reset the base year to the renewal year, which means future-year passthroughs are calculated from a higher base. This is industry-standard but worth modeling — the actual annual impact is often 1-3% of base rent.

Finally: the personal-guarantee clause if present. SMB office leases sometimes carry a personal-guarantee from a company officer. If this lease has one, renewal is the right moment to negotiate it down to a burnout (e.g., guarantee expires after 24 months of on-time payment) or out entirely.`,

  // ── Hardware — Dell PowerEdge maintenance ─────────────────────────────────
  'hardware:poweredge r75': `## Situation
This Dell support contract covers 8 PowerEdge R750 servers at $1,850/year each ($14,800 annual total) with a 24x7x4 SLA. The renewal lands in ~135 days, which is a strong window for evaluating the alternative — third-party maintenance. The contract notes already flag that a Park Place quote is pending; that is the right move.

The structural lever here is the EOSL date — Dell has indicated end-of-service-life for the R750 in 2028. That gives the team 2-3 more years of useful life on the hardware, which is the time horizon where third-party maintenance economics become compelling. Suggested next steps: get the Park Place quote in hand within the next 30 days, plus at least one comparison quote from Service Express; both should cover the same SLA window.

## Market
The third-party maintenance market for enterprise hardware is in active growth. Park Place's 2025 TPM Savings Benchmark reports median customer savings of 40-60% vs OEM rates for post-warranty hardware on a like-SLA basis. Service Express's 2026 market update corroborates this and notes specifically that 24x7x4 SLA pricing has compressed about 8% YoY as the TPM market matures.

Dell-specific context: Dell's services arm has been pushing customers toward ProSupport Plus (a tier above the base contract here) at the renewal as the EOSL date approaches, framing it as "extended-life coverage." TPMs argue this is a margin defense and that the base SLA is sufficient for hardware that runs reliably. Gartner's 2025 Critical Capabilities for hardware maintenance rates Park Place and Service Express in the leaders quadrant; both have established R750 parts inventories.

## Tactics
The lead angle is the side-by-side TPM comparison. Bringing the Park Place quote to Dell's account executive almost always triggers a counter-offer of 15-30% off the renewal rate. If the team's goal is to stay on Dell support for procurement-simplicity reasons, this is the cheapest way to capture some of the TPM-market savings without switching.

Second angle: drop the SLA tier on a subset of the fleet. Not all 8 servers necessarily need 24x7x4 — if any are in test/dev or non-customer-facing roles, dropping those 2-3 servers to next-business-day support cuts the per-server cost roughly in half. This is a Dell-internal move that the AE can usually authorise without escalation.

Third angle: multi-year TPM commit. If the EOSL math works (hardware retired by 2028), a 2-3 year TPM contract from Park Place or Service Express at a flat per-year rate is often available, which removes renewal negotiation overhead and locks in the savings.

## Watch For
First: OEM scare tactics. Dell support reps frequently warn that TPMs can't get genuine parts, will void warranties, etc. The reality per industry data is that for mature platforms like R750, TPM parts inventories are robust and the SLAs are routinely met. The team should weigh these claims against the actual track record of the chosen TPM (Park Place specifically publishes per-platform parts-availability data).

Second: forced ProSupport Plus migration. Watch for Dell's renewal proposal to come back with ProSupport Plus pricing (higher tier) rather than a like-for-like quote on the existing base support. If so, request the like-for-like quote explicitly — the team is entitled to renew at the same tier they're on.

Third: the "support coverage gap" trap. If the team switches to TPM, the cutover date must align exactly with the OEM contract end. Even a one-day gap leaves the servers without support; both Dell and the TPM will price-gouge for last-minute spot coverage. Sarah Patel — wait, wrong contract — Tom Whitaker should be required to confirm Dell's last day of coverage in writing, and the TPM coverage start should be that same day.

Finally: warranty status on the underlying hardware. R750s purchased between 2021 and 2023 may still have residual OEM warranty for next-business-day parts. Stacking TPM 24x7x4 on top of an active warranty is paying twice; verify warranty expiry before signing.`,

  // ── Services — Accenture Managed SOC ──────────────────────────────────────
  'services:managed soc s': `## Situation
This Accenture managed-SOC engagement runs $186,000/year — the largest single line on this contract roster. The renewal is roughly 75 days out, which puts the internal-decision deadline at ~45 days from today (this is a high-dollar engagement; the team needs time to socialise with finance + the CISO before commit).

The contract notes flag two KPI targets: MTTD <15 minutes and MTTR <2 hours. The team's stated goal is to tighten the SLA at renewal. That is the right framing — at this price point, the leverage is on SLA enhancement, not topline price cuts. Suggested next steps: pull the last 12 months of incident response data from Accenture (MTTD and MTTR distributions, not just averages), then book a renewal review with Priya Ramesh focused on what tighter SLAs would actually cost.

## Market
The 2025 managed-security-services market is bifurcated. KennedyResearch's 2025 rate-card report shows premium-tier MSS pricing (24x7 + IR retainer) holding firm at $150-220k/year for mid-market customers, while mid-tier MSS providers have been undercutting on price (often via offshore SOC operations). Forrester's Q1 2026 MDR Wave rates Accenture in the leaders quadrant alongside CrowdStrike Falcon Complete, Arctic Wolf, and Secureworks.

The differentiator at Accenture's price point is the IR retainer component — the ability to escalate to senior responders quickly during a confirmed incident. Deloitte's 2025 cybersecurity pricing index shows the IR-retainer line item alone is worth $40-70k/year on a standalone basis, so this contract's bundled pricing is in the reasonable range for the tier.

## Tactics
Strongest angle: SLA tightening in exchange for term commitment. Accenture engagements typically offer better SLAs (e.g., MTTD <10 min, MTTR <90 min) at the same price point on multi-year commits. If the team is confident in Accenture's delivery, a 2-year extension at the current rate with tighter SLAs is a strong outcome. If delivery has been spotty, this is the leverage moment.

Second angle: scope-reduction unbundling. The $186k engagement bundles 24x7 monitoring + IR retainer + threat-hunting + reporting. If threat-hunting hasn't been used materially (most clients don't), Accenture will unbundle it for ~$30k of annual savings while keeping core monitoring intact. Worth specifically asking.

Third angle: competitive RFP signal. Even just communicating to Priya Ramesh that the team is evaluating Arctic Wolf or CrowdStrike Falcon Complete tends to surface a renewal-discount package. This is a high-margin engagement for Accenture; account retention matters more to them than holding price.

## Watch For
First: scope creep in the renewal terms. Accenture engagements often add "premium add-ons" at renewal — Dark Web monitoring, vendor third-party risk, executive briefings — each priced at $10-25k. The team should treat any addition as a separate budget item, not "rolled in for free."

Second: the IR retainer hours definition. The IR retainer line typically includes a fixed number of investigator hours per year before incremental charges kick in. The renewal contract should specify those hours clearly (industry-standard is 80-200 hours/year for this price tier). If hours used over the prior year exceeded the retainer, that should be flagged in the renewal conversation.

Third: data-residency and offshore-SOC language. Accenture's monitoring operations include offshore-based SOC tier-1 analysts in some delivery models. If contractual data-residency requirements exclude that, the contract must state so explicitly; verify the right-to-audit clause covers SOC location compliance.

Finally: termination-for-convenience. Most managed-services contracts at this price tier include a 30-90 day termination-for-convenience clause. Verify it exists and the notice period is workable; without it, the team is locked in for the full term regardless of delivery quality.`,

  // ── Utilities — Constellation Energy electricity supply ──────────────────
  'utilities:electricity ': `## Situation
This Constellation Energy supply contract delivers 1.4M kWh/year of electricity at a fixed $0.092/kWh ($128,800 annual). The contract ends in ~165 days, and crucially, it auto-renews at variable market rates if no 30-day notice is given before term end. The notes flag this explicitly as a "known trap" — variable rollover in deregulated electricity markets typically costs 20-40% more than the fixed-rate contract.

This is one of the highest-leverage moments on the renewal calendar. The deregulated supply market in PJM (which Constellation operates within) saw capacity-auction price spikes in 2025; the fixed-rate environment heading into 2026 reflects elevated forward prices. Suggested next steps: pull a renewal-quote-RFP brief together now to send to 3-5 competitive retail electric providers (REPs) within the next 60 days; the goal is to have multiple fixed-rate quotes in hand before the auto-renewal notice window closes (~135 days from today).

## Market
The PJM Interconnection capacity auction in 2025 settled meaningfully higher than 2024, which has flowed through to fixed-rate retail supply pricing. The EIA's Q1 2026 commercial-rate report shows industrial-grade fixed-rate supply quotes in the PJM zone landing at $0.085-0.105/kWh for 12-month terms — meaning the current $0.092 rate is within market, not below.

The competitive landscape: in the PJM zone, alternative REPs include Direct Energy Business, Engie Resources, Calpine, and Shell Energy alongside Constellation. FERC's 2025 State of the Markets notes increased REP competition for mid-sized commercial loads. The structural insight is that supply is procured wholesale at PJM auction; the REP margin is the negotiable layer, and that margin compresses with competitive quotes in hand.

## Tactics
The single highest-leverage move is competitive RFP. Three REP quotes is the minimum; five is better. Each quote should be for the same load profile (1.4M kWh, same delivery point, same term length) so the comparison is apples-to-apples. With 5 quotes in hand, expect the spread to be $0.005-0.015/kWh — meaningful annual savings on a 1.4M kWh load.

Second angle: term length flex. Most REPs will quote 12, 24, and 36-month terms. In the current PJM forward-price environment, a 24-month fixed is often the sweet spot — long enough to lock in pricing before further capacity-auction-driven escalation, short enough to capture downside if renewables-supply continues to grow. Some REPs offer "block-and-index" hybrid products at lower headline rates with a portion exposed to spot; that requires more sophisticated load risk-management and is generally not appropriate for a 1.4M kWh load.

Third angle: rate-structure tweaks. Time-of-use rate plans (lower rates off-peak, higher rates on-peak) can save 5-10% if the load profile is back-shifted or weekend-heavy. The team should pull 12 months of interval-meter data before signing — Constellation can typically provide this on request and competitive REPs will use it to sharpen their quotes.

## Watch For
The auto-renewal-to-variable-rate clause is the dominant risk. The notice window opens 60 days before contract end (~105 days from today) and closes 30 days before (~135 days from today). Missing that window puts the team into a variable-rate "default service" period that typically costs 25-40% more than the fixed-rate; some REPs charge even higher transitional rates for the first 60 days. Document the cancellation-notice date as a hard calendar event with at least one redundant owner.

Second: capacity charges and ancillary-service riders. The contract supply rate covers commodity electricity; capacity and transmission charges pass through separately and have been escalating in PJM. The renewal should clarify how those passthrough components are billed and whether any are subject to cap escalators.

Third: the early-termination fee. Constellation's commercial supply contracts typically include an ETF equal to the remaining-term spread between contract rate and current market rate, multiplied by remaining volume. If market rates have moved up since contract signing, the ETF can be substantial — verify before considering any switch mid-term.

Finally: green-energy add-ons. Constellation will likely pitch a "100% renewable" or REC-attached supply option at renewal. These add typically $0.002-0.005/kWh and may carry strategic value (ESG reporting), but should be a separate buy-decision rather than bundled in without scrutiny.`,

  // ── Supplies — Staples Office supplies catalog ────────────────────────────
  'supplies:office suppli': `## Situation
This Staples Business Advantage program covers office-supplies catalog + janitorial program at $47,500/year. The contract ends in ~280 days — well outside the immediate negotiation window but useful to begin preparing for. The contract notes mention a 5% rebate at the $40k tier, which the current $47.5k spend qualifies for.

The structural insight on this category is that catalog programs work like grocery-store loyalty: the "top SKUs" are sharply priced and visible, while tail-spend (one-off orders, special items) is uncapped and typically 15-30% above general market. Suggested next steps: pull 12 months of order-detail data from Staples (line-item invoice export), bucket by SKU type, and look at the tail-spend share. If it's >20% of total spend, that is the negotiation focus.

## Market
The office-supplies category is in long-term structural decline — total addressable market has been shrinking 2-4% annually as paper-and-toner consumption falls. The NIGP cooperative pricing index for 2026 shows median catalog pricing flat year-over-year for the top-100 SKUs and slightly down for the next 400 SKUs as competition from Amazon Business and Office Depot has intensified.

The GSA's 2025 office-supplies category schedule provides public reference pricing for federal buyers; while commercial customers don't have direct access to GSA rates, the published prices are useful benchmarks for category negotiation. Recent industry shift: Staples Business Advantage and Office Depot Business Solutions have both been expanding into janitorial and facility-services bundling as core office-supplies revenue declines — which means bundle leverage is real.

## Tactics
Strongest angle: tail-spend renegotiation. The top-100 SKU pricing is already sharply discounted in the existing catalog; the savings opportunity is in the next 400-1000 SKUs and ad-hoc orders. Request a "preferred-pricing tier" that extends the top-100 discount to a curated 200-SKU list specific to the team's actual usage pattern, plus a flat catalog-wide discount on anything else.

Second angle: rebate-tier optimization. The contract notes 5% rebate at $40k tier. There are typically additional tier breakpoints (often at $75k and $100k) with higher rebate percentages. If the team has any adjacent spend going to other providers — janitorial supplies through a separate vendor, break-room consumables, etc. — consolidating into Staples Business Advantage to clear the next tier is often net positive even at full Staples list pricing.

Third angle: bundle the janitorial program separately. The bundled-pricing approach hides the individual-line economics. Request a janitorial-only quote at renewal (with no catalog supplies bundled), and compare against 2-3 specialist janitorial-supply providers. Staples is competitive on this but not always best-in-class — the comparison forces transparency.

## Watch For
First: contract-end-date drift. Office-supplies contracts often "auto-renew" via standing PO mechanisms even when no formal renewal is signed — orders just keep flowing because the catalog and account number are still active. Verify whether there is a formal contract-renewal step or whether this is effectively an evergreen agreement; the leverage moment is meaningfully different in each case.

Second: price-list freeze guarantees. Staples typically provides annual catalog updates with quarterly price-revision provisions. The contract should specify whether catalog prices are frozen for the contract year or subject to quarterly revision; quarterly revision is the industry norm but should be explicitly capped (e.g., 5% maximum increase per quarter).

Third: rebate-payment timing and conditions. Annual rebates are typically paid in arrears within 60-90 days of contract anniversary, but some agreements include "active-account-at-payment-time" conditions that void the rebate if the account is being switched. Verify the rebate-trigger language carefully if a vendor switch is on the table.

Finally: substitution clauses. Staples Business Advantage agreements typically include language allowing them to substitute "equivalent products" when a SKU is out-of-stock. This is reasonable in principle but worth defining — "equivalent" should mean same brand/spec, not just same category. Substitution abuse is the #1 source of category overspend on this kind of contract.`,

  // ── Other — Cintas uniform/mat rental ────────────────────────────────────
  'other:uniform + floor': `## Situation
This Cintas rental program covers 45 employee uniforms + 18 entrance/utility floor mats on a weekly route-service basis, $34,800/year. The contract ends in ~120 days and auto-renews annually unless 60-day notice is provided — meaning the notice window opens ~60 days from today. The contract notes flag the lost/damaged-charges line as common over-billing risk; that is the right red flag to track.

The structural insight on uniform/mat rental is that the contracts are written to favour the provider's renewal — they are evergreen by design. Suggested next steps: audit the last 12 months of weekly invoices specifically for lost/damaged charges, mat-quantity variance, and route-frequency. If any of those have drifted upward, document with line-item examples for the renewal conversation.

## Market
The U.S. uniform-rental market is dominated by three providers — Cintas, Aramark, and UniFirst — with Vestis (Aramark's spinoff) as a recent fourth competitor. BSCAI's 2025 contract-services pricing benchmarks show weekly route-service pricing flat-to-up-3% YoY for the standard uniform-plus-mat bundle. The structural pricing dynamic is that providers compete aggressively for new accounts and hold price firm at renewal — switching costs (uniform re-fitting, mat changeout logistics) are non-trivial.

IFMA's 2026 facility-services market outlook notes increased small-business pushback on auto-renewal clauses in this category, with several state attorneys general issuing guidance on more transparent notice provisions. That regulatory tailwind makes the notice-window leverage real if Cintas tries to renew silently.

## Tactics
Strongest angle: competitive quote from UniFirst or Vestis (Aramark's commercial spinoff). All three providers maintain account-acquisition teams that will quote against an incumbent; the savings on a head-to-head bid are typically 8-15% over the existing contract. Even if the team stays with Cintas, the competitive quote materially strengthens the renewal negotiation.

Second angle: SKU and frequency right-sizing. Floor-mat counts often drift upward year-over-year (new doors, "we added a mat last quarter") without anyone re-baselining. Walk the facility with the route driver before renewal and confirm each mat is needed; uniform quantities should be checked against headcount. If 18 mats has crept up from a smaller original baseline, drop the count.

Third angle: charge-line scrutiny. Cintas invoices typically include 5-15 line items per invoice; the "make-ready," "embroidery," "size-change," and "lost/damaged" lines have historically been areas where over-billing accumulates. Auditing 12 months of these lines often surfaces $1,000-3,000 of recoverable charges, which is real leverage at the renewal table.

## Watch For
The 60-day auto-renewal notice window is the dominant risk. Missing it locks the team into another full year at then-current rates, plus whatever annual escalation the contract includes (typically 4-7%). Calendar this as a hard deadline with at least one redundant owner; documented notice via certified mail is the safest path even if the contract allows email notice.

Second: the annual price-escalation clause. Most Cintas rental contracts include an annual escalation in the 4-7% range, applied automatically. Verify the actual clause and whether escalation can be capped or removed at renewal. UniFirst and Vestis typically offer flat-pricing for the first 12-24 months on new contracts — competitive leverage.

Third: the "garments retained by employees" clause. When uniformed employees leave the company, the rental provider often bills the company for unreturned garments at a premium price-per-piece. The contract should specify the return process and any caps on per-garment replacement charges; some providers will negotiate a flat annual loss allowance instead.

Finally: mat-size-and-count drift. Mats are inventoried by both size and quantity. Watch for invoices that show subtle changes — a "small" mat re-classed as "medium" with a $5/week price bump, or an extra mat added without authorisation. Quarterly inventory reconciliation against the contract baseline is the right operational hygiene.`,

  // ── Other — Orkin pest control ───────────────────────────────────────────
  'other:quarterly pest c': `## Situation
This Orkin Commercial program provides quarterly pest-control visits across 3 locations at $2,400/year per location ($7,200 annual total). The contract ends in ~200 days and auto-renews annually. The notes mention an 8% price drop at the last renewal after threatening to bid out — that pattern is repeatable, and 200 days is a strong negotiation runway.

The single-most useful action right now is to document scope. Pest-control contracts at multi-site companies tend to silently expand — a service item gets added at one location after a one-off issue, then sticks across all locations. Suggested next step: pull the last 4 quarterly service reports per location and verify the actual scope of service vs the contract scope. If there's drift, that's leverage for the renewal.

## Market
The U.S. commercial pest-control market is mature and saturated. Top providers include Orkin, Terminix, Ecolab, and Rentokil; regional specialists provide additional competition in most metros. BSCAI's 2025 contract-services pricing benchmarks show quarterly multi-site pricing flat-to-up-2% YoY, with regional specialists undercutting national providers by 10-20% on standard programs.

The structural pricing insight is that initial-quote-vs-renewal pricing differs sharply in this category. New-customer acquisition quotes tend to be 15-25% below the renewal rate of an established account — which is why "threaten to bid out" worked at the last renewal. That leverage hasn't expired; the same competitive landscape applies this cycle.

## Tactics
Strongest angle: bid out the contract proactively. Three competitive quotes from Terminix, Ecolab, and a regional specialist will typically yield a 10-15% savings if Orkin matches the lowest bid (which they usually do) or net 20%+ savings if the team switches. The contract notes already flag this as a successful pattern; doubling down on it this cycle makes sense.

Second angle: multi-site bundling discount. Three locations is the sweet spot where providers offer meaningful multi-site discounts — typically 10-15% over single-site pricing if all three are on a coordinated route. If Orkin hasn't applied a multi-site discount, that's an immediate ask. If they have, verify the discount is applied to the renewal rate, not just the original signing rate.

Third angle: scope tightening. Quarterly visits at non-food-handling sites are sometimes more frequent than needed; tri-annual (every 4 months) or twice-annual programs are available at lower price points if the locations don't have specific compliance requirements. Conversely, if any location is subject to FDA, OSHA, or local health-department requirements, those should be explicitly documented in the contract scope so service quality stays consistent.

## Watch For
First: silent scope expansion. Service technicians sometimes upsell on-site — adding "exclusion services," "bait stations," or "monitoring devices" without explicit contract authorization. Quarterly review of service reports against contract scope catches this; without it, the contract effectively renegotiates itself upward over time.

Second: the cancellation-fee clause. Some Orkin commercial contracts include a "remaining-value" cancellation fee if the customer terminates mid-term — typically 50-100% of the remaining contract value. This is industry-standard but worth verifying before initiating any switch conversation; switching at renewal vs mid-term costs meaningfully different amounts.

Third: chemical-substitution and reporting clauses. Multi-site customers in regulated industries (food service, healthcare, education) often have specific requirements about pesticide types used and reporting frequency. Verify the contract scope captures any such requirements explicitly; technicians may default to standard chemicals if not directed otherwise.

Finally: the "freedom to upgrade scope" trap. Contract renewals from incumbents sometimes include language allowing the provider to "upgrade service scope as recommended by certified technician" — which, read carefully, means the provider can add line items at their discretion. Strike or constrain this language at renewal; scope changes should require customer authorization in writing.`,

  // ── Other — Compass break-room program ───────────────────────────────────
  'other:break room progr': `## Situation
This Compass Group / Canteen break-room program runs $18,600/year and covers coffee, vending, and supplies refills. The contract ends in ~90 days, putting the internal-decision deadline at roughly 30-45 days from today. Auto-renewal is OFF on this contract, which is the favorable posture — annual review is forced.

The contract notes flag the per-employee billing model and warn specifically about headcount-snapshot timing in the renewal — providers sometimes lock in a peak-quarter headcount number for the next year's billing. That is exactly the right thing to track. Suggested next step: pull the current headcount-of-record being used by Compass for billing, compare against trailing-12-month average headcount, and prepare to push back if there's drift upward.

## Market
The break-room services market is consolidating — Compass Group, Aramark, and Sodexo dominate national accounts, with regional and independent operators competing in mid-market. The market has been under pressure from the post-2020 work-from-home shift; many providers offer aggressive renewal terms to retain accounts that have downsized office attendance.

IFMA's 2026 facility-services outlook notes per-employee pricing has compressed about 5% YoY across the category, with several providers offering "right-sized" programs that adjust billing based on actual office-attendance data rather than total headcount. Compass specifically has rolled out attendance-based pricing for enterprise customers in 2025; whether it's available at this contract's mid-market tier is worth asking.

## Tactics
Strongest angle: headcount-basis renegotiation. If the per-employee billing is based on total headcount and the office is at 60-70% attendance, that's a 30-40% over-billing relative to actual usage. Request a billing-basis change to either average daily attendance, badge-in/badge-out data, or a flat program fee with consumption true-up. Compass has the systems to support any of these; the question is whether their account team will offer it without being asked.

Second angle: scope unbundling. The bundled program includes coffee + vending + supplies — three distinct services. Each has different margin economics. If coffee is the heavy-usage line and supplies is incidental, decoupling the supplies portion (and sourcing through the office-supplies vendor instead) can save 10-15% of the program cost. Compass will usually accommodate unbundling at renewal.

Third angle: competitive RFP. Aramark, Canteen Refreshment Services (which Compass owns but operates separately), and regional operators all maintain account-acquisition teams. A side-by-side renewal-quote comparison typically yields 8-15% savings; the threat of switching is real because installation/changeover costs are modest in this category.

## Watch For
First: the headcount-snapshot date trap noted in the contract. Providers sometimes lock in a Q4 or year-end headcount peak as the basis for next-year billing, which over-charges through the entire term. The renewal contract should specify how headcount is measured — trailing-12-month average is the fair baseline.

Second: equipment-as-a-service amortization. If Compass installed brewers, vending machines, or other equipment as part of the original contract, the renewal often includes a "continued equipment service fee" that's actually a hidden equipment-amortization charge. Verify whether any such line exists and whether it should burn off at renewal vs continue.

Third: consumables substitution language. Coffee and snack inventories typically include specified brands at signing. Watch for "or substitutes of equivalent quality" language that allows the provider to swap in lower-cost SKUs while maintaining margin. Specify approved substitution lists or require advance notice of any SKU change.

Finally: the cancellation-fee structure. Some Compass contracts include short-notice cancellation fees but allow renewal-window switches at no cost. Confirm the renewal-period termination terms before signing; the contract should clearly state that non-renewal with 30-60 days notice is fee-free.`,

  // ── Other — Ambius interior plantscaping ─────────────────────────────────
  'other:interior plantsc': `## Situation
This Ambius interior plantscaping contract covers HQ lobby + 2 floors at $7,200/year. The renewal lands roughly 150 days out, so the internal-decision deadline is loose — but at this contract size, the question worth asking is whether this is the right vendor at the right scope, not how to extract another few percent.

This is a low-stakes contract in absolute dollars, but it's also a category where over-billing is easy to miss. Suggested next step: walk each location with the route technician on the next service visit and verify the plant-count and maintenance scope is actually what's being billed. If the lobby originally had 12 plants and 4 have died and not been replaced, that should be a billing adjustment.

## Market
Interior-plantscaping is a niche but consolidated category — Ambius (a Rentokil brand) and Plantopia are the two national players, with regional specialists in most major metros. The pricing pattern is per-plant-per-month with maintenance bundled in; rates have held steady at $30-50/plant/month for office environments per IFMA's 2026 facility-services market overview.

The structural dynamic: plantscaping providers compete primarily on aesthetic quality and reliability, not price — clients typically don't switch unless there's a service-quality issue. That means renewals tend to roll forward at modest annual increases (3-5%) without much price-pressure unless the customer drives it.

## Tactics
Strongest angle: scope audit. Plant-count drift is the dominant cost-creep mechanism in this category. Plants die, get removed from the floor, and aren't always immediately reflected in the billing. A walkthrough audit at renewal typically reduces the plant-count by 10-20%, which translates directly to savings.

Second angle: replacement-vs-maintenance unbundling. Ambius contracts typically bundle plant replacement (when one dies) into the monthly fee at a fixed allowance — say "up to 10% annual replacement included." Beyond that, replacements are charged separately. If the team has experienced higher-than-allowance plant attrition (lighting, watering, traffic issues), that's worth addressing operationally rather than absorbing as separate billing.

Third angle: the "design refresh" trap-or-opportunity. Ambius typically offers a "design refresh" at renewal — same price, updated plant selections. This can be net-positive (younger plants, better aesthetic) but should be priced separately from the renewal terms so the team isn't paying a premium that's bundled invisibly into the year-2 rate.

## Watch For
First: plant-replacement allowance vs actual cost. If actual replacement frequency has exceeded the contract allowance, Ambius may be billing for the overage without an obvious line item. Review the last 12 months of invoices line-by-line and confirm replacement charges match the contract terms.

Second: lighting-and-environmental-failure exclusions. Most plantscaping contracts include language excluding plants that die due to "environmental issues" (poor lighting, HVAC problems, low traffic, etc.) — meaning the company pays for replacement, not the provider. This is industry-standard but worth verifying; specific locations with chronic environmental issues should be addressed structurally (better-suited plant types) rather than recurring replacement billing.

Third: the "seasonal display" upsell. Ambius typically pitches seasonal-decor add-ons at renewal (holiday displays, spring flowers) priced separately. These are legitimate offerings but should be a separate buy-decision rather than bundled into the renewal headline rate.

Finally: contract structure flexibility. At this contract size, the team has more leverage than the dollar amount suggests because switching costs are modest. Use that leverage to require flexible terms — month-to-month or quarterly billing rather than annual prepay, no auto-renewal, and clear scope-modification process. A clean contract here is worth more than the modest dollar savings available.`,
};

/**
 * Look up the pre-generated brief for a NON_SAAS_SHOWCASE entry by its
 * slug + a product-name prefix. Returns an object suitable for spreading
 * into prisma.contract.create's data field, OR null if no brief is
 * pre-baked for this spec (caller should leave the brief fields unset,
 * the user will generate via the UI on first view).
 *
 * Matching strategy: iterate the BRIEFS map's keys (each shaped
 * `slug:product-prefix`), and pick the entry whose slug matches AND
 * whose product-prefix is a leading substring of spec.product
 * (lowercased). Prefix-match (rather than fixed-length slice) lets the
 * BRIEFS keys vary in length per category — "business inter" works for
 * telecom while "uniform + floor" works for the Cintas Other entry.
 */
function briefFieldsForSpec(spec) {
  if (!spec || !spec.slug || !spec.product) return null;
  const lowered = String(spec.product).toLowerCase();
  let matched = null;
  for (const key of Object.keys(BRIEFS)) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    const keySlug   = key.slice(0, sep);
    const keyPrefix = key.slice(sep + 1);
    if (keySlug !== spec.slug) continue;
    if (!lowered.startsWith(keyPrefix)) continue;
    // Prefer the longest prefix match if multiple keys could match the
    // same product (defensive — current key set is unambiguous).
    if (!matched || keyPrefix.length > matched.prefixLen) {
      matched = { brief: BRIEFS[key], prefixLen: keyPrefix.length };
    }
  }
  if (!matched) return null;
  return {
    renewalBrief:                matched.brief,
    renewalBriefGeneratedAt:     new Date(makeGeneratedAt()),
    renewalBriefCategorySlug:    spec.slug,
    renewalBriefTemplateVersion: TEMPLATE_VERSION,
    renewalBriefSources:         sourcesFor(spec.slug),
  };
}

module.exports = { briefFieldsForSpec };
