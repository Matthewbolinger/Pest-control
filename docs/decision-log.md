# Decision log

## 2026-07-24 — Closed-loop vertical slice first

Implement the Huntley request-to-outcome flow before breadth modules.

## 2026-07-24 — Platform persistence

Use D1 and R2 for the deployed MVP while preserving provider-neutral domain boundaries. This keeps the demo deployable without paid infrastructure.

## 2026-07-24 — Human appointment approval

Even if autonomy increases later, final appointment creation remains typed, policy-checked, attributable, and human-approved in the MVP.

## 2026-07-24 — Explainable heuristics

Use configurable, versioned contributions for recurrence risk, property completeness, and slot ranking. Do not present an unexplained AI score.

## 2026-07-24 — Completion is not resolution

`COMPLETE_JOB` records field completion, technician assessment, actual inputs,
and immutable proof, then opens a verification window. Only a separate,
attributable signal can record the outcome. A later reservice remains linked to
the original visit and final economics.

## 2026-07-24 — Vendor-neutral assurance, not FSM replacement

Keep customer/contract, dispatch, routing, invoice, payment, payroll, and
regulatory treatment authority in the connected FSM. FieldProof owns the
evidence-backed assurance, verification, exception, and outcome-economic record.

## 2026-07-24 — Private data is network-only in the PWA

Use an actor-, organization-, and job-scoped IndexedDB journal for unconfirmed
field operations and attachments. Cache only allowlisted public assets; never
cache personalized navigation, APIs, auth content, or evidence. A cold offline
navigation returns a neutral page, and sign-out purges FieldProof device state.

## 2026-07-24 — Local proof without vendor claims

Implement strict mock/CSV connector contracts and an on-demand mock
communications worker with persisted reconciliation and delivery truth.
FieldRoutes, PestPac, GorillaDesk, and production communications remain
explicitly credential-gated until exercised against their real environments.
