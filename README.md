# FieldProof

Every service visit should make the next one smarter.

FieldProof is a vendor-neutral outcome-assurance and margin operating layer for
residential pest-control companies. It is designed to sit beside a field-service
management system (FSM), not replace one. The current pilot connects a customer
request to structured triage, explicit human approval, deterministic
serviceability, margin-aware scheduling, a sourced technician brief, typed field
evidence, server-enforced completion assurance, immutable Service Proof,
independent outcome verification, reservice attribution, and an authoritative
audit trace.

Field completion is not resolution. Completing the approved field work creates
a `PENDING_VERIFICATION` outcome. A separately authorized, attributable signal
is required to record the verified result, and a later reservice remains linked
to the original job and its final economics.

## Architecture

- Vinext / React / TypeScript operations application
- Cloudflare Worker-compatible server routes
- D1 tenant-scoped normalized records and versioned workflow projections
- R2 private evidence objects with content validation and SHA-256 metadata
- Database-backed users, organization memberships, roles, permissions, and
  assigned-technician enforcement
- Versioned evidence policies and immutable playbook assignments
- Expected, actual, and final contribution economics
- Durable outbox, proof-delivery, integration-sync, and reconciliation records
- Provider-neutral AI and FSM/communications adapter contracts
- IndexedDB operation journal with ordered replay, idempotency, leases,
  attachment durability, retry/backoff, auth blocking, and conflict recovery
- PWA registration that caches only allowlisted public assets; authenticated
  HTML, API responses, evidence, and other private content remain network-only

See [architecture](docs/architecture.md), [data model](docs/data-model.md),
[competitive analysis](docs/competitive-analysis.md), and
[assumptions](docs/assumptions.md).

## Prerequisites

- Node.js 22.13 or newer
- npm

## Local setup

```bash
npm install
cp .env.example .env.local
npm run db:generate
npm run dev
```

The local runtime supplies D1- and R2-compatible bindings. No paid AI, maps,
communications, or FSM credentials are required for the deterministic pilot.

## Commands

```bash
npm run dev
npm run lint
npm run typecheck
npm run test
npm run evals
npm run build
npm run test:artifact
npm run test:e2e
```

## Identity and authorization

Hosted pages and API writes require platform identity. Localhost uses explicitly
fictional personas for role and assignment tests. Each request resolves a
database-backed active user and organization membership; permissions are
default-deny by role, and technician field writes require the membership's
linked technician to match the assigned job.

The deployed experience is still a private Northstar pilot. It automatically
provisions its hosted pilot owner and does not yet provide customer-facing
invitation, role-administration, suspension, or removal screens. Those
administrative lifecycle controls must be completed before a shared production
rollout.

## Demo workflow

Use the priority Morrison request:

1. Generate a validated triage proposal and record explicit human approval.
2. Compare ranked candidates and approve Maya Chen at 1:30 PM
   (`SC-2401 · TECH-04`).
3. Check in as the assigned technician and complete four confirmed steps.
4. Upload a `BEFORE / AREA_OVERVIEW` image and a
   `DURING / ENTRY_POINT` image, then record a structured observation.
5. Review risk and enter actual drive time, material cost, and completion note.
6. Mark field work complete. Confirm the outcome is still
   `PENDING_VERIFICATION` and inspect the immutable Service Proof hash.
7. Queue proof delivery and process it with the deterministic mock
   communications adapter. Queued is not delivered; only the adapter receipt
   changes the delivery to `DELIVERED`.
8. Record a separately attributable customer-confirmed outcome. Optionally link
   a reservice and its direct cost to see final contribution change.
9. Inspect Playbooks, Outcomes, Integrations, Exceptions, Audit, and health
   telemetry, then reload to confirm authoritative state persists.

See the full [demo script](docs/demo-script.md).

## Offline and PWA behavior

Field commands and evidence are written to an actor-, organization-, and
job-scoped IndexedDB journal before network submission. Confirmed server
versions remain authoritative; offline data cannot satisfy the server
completion policy until replay succeeds. Retries reuse the same idempotency
keys, preserve dependency order, and stop for authentication or human recovery
when required.

The service worker never caches personalized navigation responses, API data,
auth routes, or evidence. A cold offline navigation shows a neutral offline
page; queued field work remains on the device and resumes only after the signed-
in application reconnects. Signing out purges FieldProof caches and local
journals.

## Environment and persistence

The pilot uses `AI_PROVIDER=mock`. Optional provider-compatible variables are
documented in `.env.example`; production secrets belong in the hosted secret
manager, never source control.

Checked-in Drizzle migrations create normalized operating records, workflow
snapshots, command receipts, evidence metadata, outcomes and checkpoints,
reservice links, economics, proof and delivery records, audit, outbox, and
integration reconciliation state. The first authorized read initializes the
fictional Huntley records idempotently.

## Production boundary

The repository contains a production-shaped pilot, not proof of production
readiness or market leadership. Mock and CSV contracts are locally testable;
FieldRoutes, PestPac, and GorillaDesk capabilities remain explicitly
credential-gated. Proof delivery uses an on-demand mock worker, not a production
sender.

Live use still requires vendor sandbox credentials, a production communications
provider and consent flow, real design-partner field trials, calibrated risk and
outcome windows, and formal security, privacy, accessibility, legal, retention,
backup/restore, disaster-recovery, and operational reviews. See
[deployment](docs/deployment.md) and the [master plan](docs/master-plan.md).
