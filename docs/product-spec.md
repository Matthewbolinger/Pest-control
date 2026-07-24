# FieldProof product specification

FieldProof is a vendor-neutral service-outcome and margin operating layer for
residential pest-control operators. It sits beside an FSM and owns the assurance
record around a visit; it does not replace dispatch, routing, CRM, invoicing,
payments, payroll, or regulatory treatment records.

Its north star is **verified-resolved contribution per technician-day**,
balanced with assurance coverage, evidence completeness, verification coverage,
first-visit verified resolution, avoidable reservice, proof latency, exception
age, and technician capture time.

## Core loop

Request → Triage → Plan → Schedule → Prepare → Inspect → Document → Complete
field work → Issue proof → Verify → Follow up → Attribute reservice → Measure →
Learn

Completion, proof generation, proof delivery, independent verification, and
resolution are separate events. Unknown outcomes remain unknown. A technician's
clear assessment cannot create a verified resolution, and a later reservice
must remain attributable to the original job and economics.

The repository pilot proves this loop for a fictional Huntley basement rodent
concern. Final operational decisions use deterministic policy and economics. AI
is narrow: classification, extraction, summarization, and explanation.

## Implemented surfaces

- **Control Tower** — current operating state and work requiring attention.
- **Service Requests** — structured triage with source traceability and human
  approval.
- **Schedule** — eligible advisory candidates ranked by expected contribution
  and route fit.
- **Jobs** — assigned-technician brief, versioned checklist, observation,
  typed evidence policy, risk review, and actual inputs.
- **Service Proof** — immutable sourced facts, delivery state, verification,
  and reservice actions.
- **Property Intelligence** — durable property and risk history.
- **Exceptions** — owner and resolution-note control.
- **Playbooks** — the active immutable version and server completion
  requirements.
- **Outcomes** — expected, actual, and final contribution plus the assurance
  timeline.
- **Integrations** — mock shadow reconciliation, capabilities, sync health,
  outbox, and production credential gates.
- **Audit** — attributable server-side decision trace.

## Pilot boundary

The active product runs one seeded job and one rodent playbook version with mock
AI, FSM, and communications paths. The normalized data, policy, identity,
offline, outcome, and integration foundations are broader than that fixture,
but production claims require multiple service archetypes, real vendor
credentials, a live delivery provider, customer field evidence, calibrated
policy, and formal operational/legal review.
