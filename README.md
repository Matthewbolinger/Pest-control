# FieldProof

Every service visit should make the next one smarter.

FieldProof is an AI-native service-outcome and margin operating layer for residential pest-control companies. This pilot connects a customer request to structured triage, explicit human approval, deterministic serviceability, margin-aware scheduling, a sourced technician brief, field evidence, a server-enforced completion policy, Service Proof, property risk, follow-up, contribution economics, and an authoritative audit trace.

## Architecture

- Vinext / React / TypeScript operations application
- Cloudflare Worker-compatible server routes
- D1 tenant-scoped structured records
- R2 private evidence objects
- Drizzle schema and migrations
- Zod input/output validation
- Provider-neutral AI and integration contracts
- D1-backed versioned workflow snapshots and idempotent commands
- IndexedDB only for unconfirmed technician drafts and upload retry

See [architecture](docs/architecture.md), [data model](docs/data-model.md), and [assumptions](docs/assumptions.md).

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

The local runtime supplies D1 and R2-compatible bindings. No paid AI, maps, communications, or field-service credentials are required.

## Commands

```bash
npm run dev
npm run lint
npm run typecheck
npm run test
npm run test:artifact
npm run test:e2e
npm run evals
npm run build
```

## Identity and pilot scope

The deployed pilot is protected by platform identity. Browser pages and API writes reject missing hosted identity; localhost receives a clearly marked fictional demo identity. The current deployment is a single-tenant Northstar pilot, and every server query derives its organization and actor instead of accepting them from the client.

Broader organization membership lifecycle and role administration remain production-hardening work; the UI no longer presents a role preview as authorization.

## Demo workflow

Use the priority Morrison request on the Control Tower:

1. Generate a validated triage proposal.
2. Record explicit human triage approval.
3. Compare candidates and approve a ranked slot.
4. Check in as the assigned technician.
5. Complete four server-confirmed inspection steps.
6. Upload two attributable evidence images and record the basement observation.
7. Review the risk as clear or unresolved.
8. Complete the job and review the server-generated Service Proof.
9. Queue the Service Proof delivery request, reload, and confirm the assignment, outcome, risk, proof, and audit trace persist.

See the full [demo script](docs/demo-script.md).

## Environment variables

The main demo uses `AI_PROVIDER=mock`. Optional provider-compatible variables are documented in `.env.example`. Production secrets belong in the hosted secret manager, never source control.

## Database and seed data

`npm run db:generate` generates D1 migrations from `db/schema.ts`. Checked-in migrations create the workflow snapshot, command-receipt, evidence, audit, outbox, outcome, margin, and follow-up records used by the pilot. The first authenticated read initializes the fictional Huntley workflow if it does not exist.

## Troubleshooting

- If the dev port is occupied, the server selects another local port.
- If a field command or evidence upload is offline, the draft remains in IndexedDB and is clearly excluded from completion until the server confirms it.
- If schema bindings are missing, confirm `.openai/hosting.json` declares `DB` and `EVIDENCE`.
- If a build changed dependencies, run `npm install` to refresh the lockfile.

## Production considerations

This is a hardened pilot vertical slice, not the full enterprise scope. The core request-to-proof workflow is now server-authoritative, versioned, idempotent, and browser-tested. Before live customer use, complete the controls in [deployment](docs/deployment.md) and [threat model](docs/threat-model.md), implement the full organization membership lifecycle, add a production outbox consumer, expand provider/integration coverage, and perform formal security, accessibility, privacy, and legal reviews.
