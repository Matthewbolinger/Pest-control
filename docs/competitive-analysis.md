# FieldProof competitive analysis

Review date: 2026-07-24
Scope: FieldRoutes, PestPac/Wavelytics, GorillaDesk, Briostack, Fieldwork,
PestBoss, and the current FieldProof repository

## Executive verdict

FieldProof should not claim to be the best pest-control platform today.
Established competitors are materially ahead in customer acquisition, CRM,
scheduling, routing, mobile field operations, billing, payments, portals,
chemical and device records, reporting, and installed-market proof.

FieldProof does have a differentiated product thesis: make each visit produce an
attributable assurance record that distinguishes field completion from
independently verified resolution, preserves required evidence and policy
versions, links later reservice to the originating visit, and reconciles final
contribution. That combination was not found in the reviewed public product
materials. This is white space, not proof of a moat. A public-page review cannot
establish that a competitor lacks a private, newly released, configurable, or
partner-delivered capability.

The winning strategy is therefore:

1. integrate beside the systems operators already use;
2. become the trusted outcome and assurance layer for their visits;
3. prove field reliability, adoption, and economic value with real operators;
4. feed verified assurance events back into incumbent systems and analytics;
5. make a market-leadership claim only after independent customer and outcome
   evidence supports it.

## Evidence discipline

This review uses official vendor product pages, documentation, releases, and
vendor-published case studies only. It does not use review sites, anonymous
comments, sales calls, contracts, sandboxes, or independent customer
interviews.

The terms below are deliberately narrow:

- **Officially stated** means the vendor describes the capability in the
  reviewed public material. It is not independent validation of quality,
  adoption, performance, or availability on every plan.
- **Roadmap** means the vendor labels the capability as planned, coming soon, or
  otherwise subject to change. It is not treated as generally available.
- **Not found** means the capability was not identified in the reviewed source
  set. It does not mean the capability does not exist.
- **Implemented** means the behavior exists in this repository and is covered
  by local code or tests. It does not mean it has survived production traffic
  or field use.
- **Unproven** means a production-shaped implementation or claim lacks live
  vendor, device, operator, or outcome evidence.
- **External gate** means completion depends on credentials, a provider,
  customer access, compliance work, or another condition outside the current
  repository.

Vendor marketing claims and vendor-published performance figures are recorded
as claims, not independently verified facts.

## Official source set

| Vendor | Reviewed official material | What the material establishes |
| --- | --- | --- |
| FieldRoutes | [Operations Suite][fr-core], [routing][fr-routing], [API][fr-api], [offline case evidence][fr-offline] | CRM, scheduling, bulk route optimization, reporting, payments and portal, mobile operations, integrations/API, WDO-related workflows, and a vendor-published customer account of offline capture followed by synchronization are publicly stated. |
| PestPac / Wavelytics | [PestPac platform][pp-core], [Wavelytics Decision Intelligence][pp-di], [launch announcement][pp-news] | PestPac publicly states broad residential/commercial FSM, mobile, routing, chemical tracking, inspection, reporting, portal, accounting, and analytics. Wavelytics states near-real-time intelligence, scorecards, leaderboards, problems, and callback-trend detection. Its page labels some AI query functionality as roadmap. |
| GorillaDesk | [Pest-control product][gd-core], [route planning][gd-route], [AI agents][gd-ai] | Scheduling, routing, GPS, customer communications, digital documents, material-use records, integrations, and customer-channel AI agents are publicly stated. |
| Briostack | [Pest-control product][bs-core], [scheduling and routing][bs-route] | Scheduling, route optimization, technician mobile work, CRM, billing, reporting, customer communications, chemical-use reporting, service summaries, and reservice summaries are publicly stated. |
| Fieldwork | [Pest-control product][fw-core], [work-order management][fw-work] | CRM, scheduling, route planning, invoicing, portal, chemical reporting, barcode/device tracking, work-order history, signatures, attachments, and an offline-capable mobile workflow are publicly stated. |
| PestBoss | [PestBoss platform][pb-core] | Online/offline field work, site mapping, barcode/device monitoring, service and compliance reports, CRM, scheduling, invoicing, payments, portal, and pesticide/device analytics are publicly stated. |

## Capability comparison

`OS` = officially stated, `RM` = vendor roadmap, `NF` = not found in the
reviewed public sources, `I` = implemented in FieldProof, `U` = implemented or
designed but unproven in live use, and `G` = external gate.

| Capability | FieldRoutes | PestPac / Wavelytics | GorillaDesk | Briostack | Fieldwork | PestBoss | FieldProof now |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CRM and scheduling | OS ([source][fr-core]) | OS ([source][pp-core]) | OS ([source][gd-core]) | OS ([source][bs-core]) | OS ([source][fw-core]) | OS ([source][pb-core]) | Deliberately out of scope; consumes authoritative records |
| Route optimization and dispatch | OS ([source][fr-routing]) | OS ([source][pp-core]) | OS ([source][gd-route]) | OS ([source][bs-route]) | OS ([source][fw-work]) | Scheduling stated ([source][pb-core]) | Advisory ranking only; external FSM remains authoritative |
| Invoicing, payments, accounting, portal | OS ([source][fr-core]) | OS ([source][pp-core]) | OS ([source][gd-core]) | OS ([source][bs-core]) | OS ([source][fw-core]) | OS ([source][pb-core]) | Deliberately out of scope |
| Pest-specific chemical, WDO, device, or compliance workflow | WDO inspection/compliance OS ([source][fr-core]) | Chemical tracking and termite inspection OS ([source][pp-core]) | Material-use records OS ([source][gd-core]) | Chemical-use reporting OS ([source][bs-route]) | Chemical and barcode/device tracking OS ([source][fw-core]) | Pesticide, device, mapping, and compliance reporting OS ([source][pb-core]) | Evidence assurance only; not a regulatory system of record |
| Offline-capable field execution | OS in a vendor-published customer case study; implementation guarantees were not independently tested ([source][fr-offline]) | Publicly stated on an official comparison page; not independently exercised ([source][pp-offline]) | NF | NF | OS ([source][fw-work]) | OS ([source][pb-core]) | I/U: durable local journal and replay exist; supported-device and field validation remain open |
| Callback, reservice, or operational trend reporting | Reservice/retreat tracking and follow-up are described in vendor case material ([source][fr-reservice]) | Callback-trend detection OS in Wavelytics material ([source][pp-di]) | Reporting/review engine OS ([source][gd-core]) | Completion and reservice summary reports OS ([source][bs-route]) | Work-order history and reporting OS ([source][fw-work]) | Monitoring and analytics OS ([source][pb-core]) | I/U: per-job linked reservice and final economics; fleet/cohort denominators are not complete |
| AI-led customer interaction or decision intelligence | AI automation is publicly framed as a continuing roadmap, not the reviewed core assurance capability ([source][fr-ai]) | Decision Intelligence OS; natural-language query functionality partly RM ([source][pp-di]) | Phone, SMS, web-chat, and portal agents OS ([source][gd-ai]) | NF | NF | NF | I/U: narrow mock extraction and proposals; no production provider |
| Server-enforced versioned completion assurance | NF | NF | NF | NF | NF | NF | I: required steps, observations, evidence, risk review, and pinned policy are server enforced for the pilot |
| Immutable sourced service proof distinct from delivery | NF | NF | NF | NF | NF | Service reports OS, but the reviewed page does not establish an immutable assurance artifact ([source][pb-core]) | I/U: persisted-fact hash and separate delivery state exist; production sender is G |
| Independent outcome verification distinct from technician completion | NF | NF | NF | NF | NF | NF | I/U: a separately attributable staff attestation path exists; direct customer/provider verification is G |
| Contradiction window plus linked reservice economics | NF | Callback analysis OS, but the complete assurance chain is NF ([source][pp-di]) | NF | Reservice report OS, but linked final assurance economics are NF ([source][bs-route]) | NF | NF | I/U: distinct child reservice and final contribution exist for the pilot |
| Live integration with the product | N/A | N/A | N/A | N/A | N/A | N/A | G: mock and CSV reconciliation exist; live FieldRoutes, PestPac, and GorillaDesk behavior is not verified |

Every `NF` above is limited to the cited source set. It must be retested during
vendor demos and sandbox discovery before being used in positioning or sales.

### FieldProof implementation evidence

| Claim | Repository evidence | Current confidence |
| --- | --- | --- |
| Ordered, server-authoritative completion assurance | [`workflow.ts`](../packages/application/workflow.ts), [`workflow/route.ts`](../app/api/v1/workflow/route.ts), [`workflow-server-authority.test.ts`](../tests/workflow-server-authority.test.ts) | Implemented and locally tested; one active pilot workflow |
| Immutable proof, explicit delivery, independent verification, and reservice | [`proof-delivery.ts`](../packages/application/proof-delivery.ts), [`outcomes.ts`](../packages/domain/outcomes.ts), [`proof-delivery.test.ts`](../tests/proof-delivery.test.ts) | Implemented and locally tested; live sender and direct customer signal are external gates |
| Outcome-adjusted economics | [`economics.ts`](../packages/domain/economics.ts), [`economics-v2.test.ts`](../tests/economics-v2.test.ts) | Implemented per job; cohort and fleet validation incomplete |
| Durable offline command and evidence journal | [`offline-store.ts`](../packages/client/offline-store.ts), [`sync-engine.ts`](../packages/client/sync-engine.ts), [`offline-sync.test.ts`](../tests/offline-sync.test.ts) | Implemented and locally tested; supported-device field proof incomplete |
| Vendor-neutral mappings, capabilities, receipts, and reconciliation | [`integrations/index.ts`](../packages/integrations/index.ts), [`integrations/route.ts`](../app/api/v1/integrations/route.ts), [`integrations.test.ts`](../tests/integrations.test.ts) | Mock and CSV implemented; vendor credentials and live behavior are external gates |

## Competitor-by-competitor assessment

### FieldRoutes

**What is good**

- It presents a broad pest-control operating suite: CRM, scheduling, high-volume
  route optimization, collections, mobile work, reporting, portal, integrations,
  and WDO workflows.
- Its routing material explicitly covers bulk optimization across many stops,
  technician skill matching, drive-time considerations, and mobile dispatch.
- The API and integration positioning makes it a plausible upstream system of
  record and a high-priority FieldProof partner.

**What is bad for FieldProof / still unknown**

- Rebuilding FieldRoutes' operating breadth would consume years while erasing
  FieldProof's differentiated boundary.
- A vendor-neutral assurance layer must demonstrate that it adds value without
  slowing a mature dispatch and technician workflow.
- Vendor case material supports offline capture and later synchronization, but
  does not expose the conflict, identity-change, attachment-pressure, or
  stale-assignment guarantees FieldProof would need to compare directly. The
  complete FieldProof assurance chain also was not established in the reviewed
  material.

**FieldProof response**

Start with read-only job, technician, customer, appointment, and service-history
ingestion. Return proof URL, assurance status, exception, and verified outcome
only after shadow reconciliation demonstrates exact mapping and idempotency.

### PestPac and Wavelytics

**What is good**

- PestPac publicly presents the deepest enterprise/commercial operating scope in
  this set, including multi-unit field work, routing, mobile, chemical tracking,
  termite inspection, forms, accounting, portal, reporting, and analytics.
- Wavelytics directly targets operational and financial intelligence, including
  revenue per labor hour, contract margin, callback spikes, scorecards,
  leaderboards, and prescriptive problem surfacing.
- Its Data Factory and role-aware intelligence positioning make generic
  dashboards or a generic natural-language analytics assistant poor FieldProof
  bets.

**What is bad for FieldProof / still unknown**

- Wavelytics competes close to FieldProof's proposed learning and margin layer.
  FieldProof cannot win with a nicer dashboard or an unsourced AI recommendation.
- Some Wavelytics functionality is explicitly roadmap material and subject to
  change, so current and planned behavior must not be conflated.
- The reviewed pages did not establish an immutable, policy-versioned chain from
  completion evidence through independent verification and reservice-adjusted
  economics.

**FieldProof response**

Produce higher-integrity work-level assurance events that PestPac/Wavelytics can
consume. Treat their warehouse and dashboards as distribution channels. Win on
source traceability, state semantics, contradiction handling, and intervention
measurement rather than generic business intelligence.

### GorillaDesk

**What is good**

- It combines approachable FSM breadth with route planning, GPS, mobile
  dispatch, communications, documents, material-use records, reporting,
  integrations, and a customer portal.
- Its AI agents cover phone, SMS, web chat, and portal requests, including lead
  capture and booking.
- This is a strong small-to-mid-market benchmark for time-to-value and reduced
  administrative work.

**What is bad for FieldProof / still unknown**

- Another receptionist, chat agent, or booking assistant would be
  undifferentiated.
- The reviewed materials did not establish offline field behavior or the full
  FieldProof assurance chain.
- FieldProof's more rigorous controls could feel heavy beside GorillaDesk unless
  technician capture time and manager value are proven.

**FieldProof response**

Accept intake and booking context from GorillaDesk, keep capture requirements
service-specific, and return a concise proof/outcome signal. Hold the pilot to a
strict technician-time budget.

### Briostack

**What is good**

- It covers pest-specific scheduling, route optimization, mobile completion,
  CRM, billing, communications, chemical reporting, dashboards, and a public
  API.
- Its completion and reservice reports show that operators already expect
  callback visibility.
- Its positioning is practical for smaller operations that need an integrated
  suite rather than an enterprise data program.

**What is bad for FieldProof / still unknown**

- A reservice summary report narrows the novelty of merely counting callbacks.
  FieldProof must prove causally useful linkage to the original visit, policy,
  evidence, and final contribution.
- Offline behavior and the end-to-end assurance chain were not found in the
  reviewed pages.

**FieldProof response**

Do not sell "reservice reporting." Sell governed attribution: which original
visit, evidence gap, unresolved risk, playbook version, and intervention are
associated with the reservice, with unknowns kept explicit.

### Fieldwork

**What is good**

- Its official work-order material explicitly states offline functionality,
  technician and customer signatures, attachments, task checklists, history,
  scheduling, routing, and real-time office visibility.
- It combines chemical reporting, barcode/device tracking, CRM, invoicing,
  payments, and a portal in one field-oriented product.
- It creates a credible minimum bar for reliable mobile pest-control work.

**What is bad for FieldProof / still unknown**

- FieldProof cannot call offline capture a market differentiator until it passes
  supported-device, storage-pressure, interrupted-upload, identity-change, and
  prolonged-disconnection tests.
- The reviewed material did not establish that work-order completion is kept
  semantically separate from independently verified resolution.

**FieldProof response**

Benchmark reliability and capture speed directly against Fieldwork-like
conditions. Differentiate after synchronization through assurance policy,
immutable proof, independent verification, contradiction, and measured
learning.

### PestBoss

**What is good**

- PestBoss publicly states online/offline technician work, site mapping,
  barcode/device monitoring, service and regulatory reports, CRM, scheduling,
  invoices, payments, portal access, and pesticide/device analytics.
- Its commercial site and monitoring depth is a stronger pest-specific
  execution model than a generic residential work-order app.

**What is bad for FieldProof / still unknown**

- FieldProof should not reproduce site mapping, device servicing, pesticide
  records, or compliance reports.
- A service report is not automatically an immutable assurance proof, but the
  reviewed public page alone cannot establish how PestBoss records provenance,
  edits, or outcome follow-up.

**FieldProof response**

Reference external device and treatment records, require only the evidence
needed by the assigned assurance policy, and preserve a link back to the
regulatory system of record.

## FieldProof: what is genuinely strong

- **Truthful state semantics.** Field work, proof generation, proof delivery,
  independent verification, contradiction, and reservice are separate.
- **Server-side assurance.** A browser cannot declare completion while required
  steps, observations, evidence, or risk review are missing.
- **Version and source traceability.** The assigned playbook and evidence policy
  are pinned, proof hashes persisted facts, and commands are attributable.
- **Vendor-neutral architecture.** The canonical model and adapter capability
  contracts are designed to avoid leaking one FSM's semantics into the domain.
- **Outcome-adjusted economics.** Expected, actual, and final contribution are
  separated, and reservice cost can remain attached to the originating job.
- **Safety boundary.** AI proposes and summarizes; deterministic policy and
  authorized humans control material actions.

These are implementation strengths in the current pilot, not customer-proven
advantages.

## FieldProof: what is weak or incomplete

- The active experience is still one seeded Huntley rodent job, one playbook,
  and one property. Multi-job flexibility is architectural, not demonstrated at
  market scale.
- There is no live, verified FieldRoutes, PestPac, or GorillaDesk connector.
  Mock and CSV contracts do not establish vendor compatibility.
- Offline logic has extensive local tests but no supported-device matrix,
  storage-pressure qualification, long-disconnection trial, or measured field
  adoption.
- Proof delivery is a deterministic mock, not a consent-aware production
  communication provider with webhook, bounce, and opt-out handling.
- The customer-confirmed outcome path records a staff attestation. It is not a
  direct authenticated customer response or provider-signed signal.
- Per-job economics exist, but fleet denominators, cohort quality controls,
  causal intervention evaluation, and privacy-safe benchmarking do not.
- Risk weights and verification windows are not calibrated from field outcomes.
- Invitations, role administration, access reviews, retention, backup/restore,
  disaster recovery, accessibility, privacy, legal, and security review remain
  production gates.
- There is no design-partner evidence yet that technicians will complete the
  capture flow quickly, managers will act on exceptions, customers will verify,
  or operators will save more than the product costs.

## Strategic white space

The reviewed market is crowded with systems that schedule a visit, route a
technician, record treatment, send a report, invoice the customer, and analyze
operations. FieldProof's potential white space is the governed bridge between
"the work order was completed" and "the intended result was independently
verified and economically understood."

That bridge has six parts:

1. **Policy-bound readiness and completion:** service-specific requirements are
   evaluated on the server against a pinned version.
2. **Sourced Service Proof:** performed work and observations are attributable,
   integrity checked, and kept distinct from customer delivery.
3. **Independent verification:** a technician's assessment cannot verify their
   own result.
4. **Contradiction handling:** recurrence, callback, and reservice can supersede
   an earlier result without erasing history.
5. **Final economics:** later warranty and reservice costs reconcile back to the
   originating visit.
6. **Measured intervention learning:** a playbook change is promoted only when
   governed cohorts show improvement, not because an AI summary sounds
   plausible.

This white space becomes a moat only if FieldProof accumulates trusted,
cross-system outcome history that is expensive to reproduce and demonstrably
improves operator decisions.

## Anti-roadmap

FieldProof should not rebuild:

- general CRM, lead management, proposals, or recurring-contract management;
- a drag-and-drop dispatch board or general route optimizer;
- fleet GPS, timekeeping, payroll, commissions, or technician tipping;
- invoicing, collections, card processing, accounting, or tax workflows;
- a general customer portal, review engine, or marketing suite;
- an AI receptionist for phone, SMS, web chat, or booking;
- chemical labels, dilution calculations, application instructions, state
  reports, termite forms, device maps, or the regulatory system of record;
- a generic data warehouse, dashboard builder, or natural-language BI layer;
- a broad document-template or e-signature platform.

Small integration-facing views are acceptable when they explain source,
reconciliation, assurance state, or an intervention. They must not become a
second system of record.

## Prioritized moat plan and measurable gates

| Priority | Program | Required proof gate |
| --- | --- | --- |
| P0 | Multi-job assurance core | Run at least 100 fixture jobs across two fictional organizations and five service archetypes; zero cross-tenant access, false completions, or duplicate side effects in the acceptance suite. |
| P0 | Field reliability | Pass at least 100 offline scenarios across supported iOS and Android devices, including restart, storage pressure, interrupted upload, stale version, sign-out, and identity change; lose zero confirmed records and leave fewer than 1% of operations unresolved after 24 hours. |
| P0 | Live read-only integration | Reconcile at least two live FSM sandboxes or design-partner exports for 30 consecutive days; 100% of mapped source records retain vendor ID/version provenance and at least 99.9% reconcile without manual correction. |
| P0 | Direct verification and delivery | Add a consent-aware production communications provider with signed webhooks, bounce/opt-out state, replay protection, and direct customer attribution; no provider event may bypass verifier independence or policy windows. |
| P1 | Technician and manager adoption | Across at least three design partners, achieve a pre-registered technician capture-time target, at least 90% assurance-policy completion on eligible visits, and manager disposition of material exceptions inside the agreed service-level target. |
| P1 | Outcome coverage | Measure at least 1,000 eligible visits across multiple service types; report verification coverage, unknown rate, contradiction rate, and loss to follow-up with denominators and confidence intervals. Do not convert unknown outcomes into successes. |
| P1 | Economic validation | Pre-register the baseline and success threshold with each design partner; show a credible reduction in avoidable reservice or an improvement in verified-resolved contribution that exceeds implementation and operating cost. Publish negative or neutral results internally. |
| P1 | Intervention evaluation | Compare playbook versions or interventions only with governed cohorts, documented eligibility, exposure, confounders, minimum sample, and rollback criteria. No automated promotion from a single case. |
| P2 | Controlled write-back | After shadow parity, write only proof link, assurance status, exception, and verified outcome to an allowed sandbox; require idempotency, audit, tenant isolation, rollback, and capability-specific kill switches. |
| P2 | Trust and production readiness | Complete independent security testing, privacy/legal review, accessibility audit, retention/deletion controls, backup/restore exercise, disaster-recovery exercise, and access-lifecycle administration before shared production use. |
| P3 | Cross-FSM learning network | Ship privacy-safe benchmarks only after data-quality grades, tenant minimums, aggregation thresholds, opt-in governance, and re-identification review are approved. |

### Market-leadership claim ladder

FieldProof should advance its language one level at a time:

1. **Differentiated pilot:** the repository demonstrates a novel assurance loop.
2. **Reliable field product:** device, sync, security, and provider gates pass.
3. **Useful design-partner product:** technicians adopt it and managers act on
   its exceptions.
4. **Economically validated product:** governed field data shows positive net
   value.
5. **Market-leading assurance layer:** multiple operators and FSMs show durable,
   independently referenceable superiority on assurance coverage, verified
   resolution, avoidable reservice, and outcome-adjusted contribution.

The current repository is at level 1.

## Conclusion

FieldProof has a strong assurance thesis and a credible production-shaped pilot.
It is not yet market-proven, production-ready, or the best platform in the
market. Incumbents are better complete operating systems today, and FieldProof
should benefit from that fact by integrating with them.

The defensible path is narrow and demanding: become the most trustworthy way to
prove what happened during a service visit, verify what happened afterward,
attribute contradictions and reservice, and turn that truth into better
playbooks and contribution. If FieldProof clears the measurable field,
integration, trust, and economic gates above, it can credibly lead that category
without pretending to replace the systems that already run the business.

[fr-core]: https://www.fieldroutes.com/operations-suite/
[fr-routing]: https://www.fieldroutes.com/operations-suite/field-service-routing/
[fr-api]: https://www.fieldroutes.com/operations-suite/api-integrations
[fr-offline]: https://www.fieldroutes.com/resources/case-studies/uinta-pest-solutions-case-study
[fr-reservice]: https://www.fieldroutes.com/resources/case-studies/all-clear-pest-control-case-study
[fr-ai]: https://www.fieldroutes.com/blog/a-promise-to-make-ai-accessible-to-the-trades
[pp-core]: https://www.pestpac.com/
[pp-di]: https://www.pestpac.com/wavelytics/decision-intelligence
[pp-news]: https://www.pestpac.com/newsroom/workwave-announces-wavelytics-tm-decision-intelligence-evolving-traditional-reporting-into-prescriptive-action
[pp-offline]: https://www.pestpac.com/compare/fieldroutes-vs-pestpac
[gd-core]: https://gorilladesk.com/industries/pest-control-software/
[gd-route]: https://gorilladesk.com/features/route-planning-software/
[gd-ai]: https://gorilladesk.com/features/ai-agents/
[bs-core]: https://www.briostack.com/pest-control-software/
[bs-route]: https://www.briostack.com/pest-control-software/scheduling-routing-software
[fw-core]: https://fieldworkhq.com/industries/pest-control-software/
[fw-work]: https://fieldworkhq.com/features/work-order-management/
[pb-core]: https://www.pestboss.com/
