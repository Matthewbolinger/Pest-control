# FieldProof

Every service visit should make the next one smarter.

FieldProof is an AI-native service-outcome and margin operating layer for residential pest-control companies. The MVP connects a customer request to structured triage, deterministic serviceability, margin-aware scheduling, a sourced technician brief, field evidence, completion policy, Service Proof, property risk, follow-up, contribution economics, and audit trace.

## Architecture

- Vinext / React / TypeScript operations application
- Cloudflare Worker-compatible server routes
- D1 tenant-scoped structured records
- R2 private evidence objects
- Drizzle schema and migrations
- Zod input/output validation
- Provider-neutral AI and integration contracts
- IndexedDB only for technician offline drafts

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
npm run test:e2e
npm run evals
npm run build
```

## Demo roles

The deployed demo is protected by platform identity. Inside the product, the **Preview role** control switches between explicit demo perspectives:

- Owner — Control Tower, economics, outcomes, exceptions
- Dispatcher — request triage and schedule approval
- Technician — mobile field workflow

The role preview is not an authorization mechanism. Production roles are `OWNER`, `MANAGER`, `DISPATCHER`, `TECHNICIAN`, `ADMIN`, and `READ_ONLY`, enforced server-side through organization membership.

## Demo workflow

Use the priority Morrison request on the Control Tower:

1. Run triage.
2. Compare and approve a ranked slot.
3. Check in as Maya Chen.
4. Complete four inspection steps.
5. Add two evidence items and the basement observation.
6. Flag the unresolved north sill-plate entry point.
7. Complete the job and review Service Proof SP-2048.
8. Inspect the updated property, exception, analytics, and audit views.

See the full [demo script](docs/demo-script.md).

## Environment variables

The main demo uses `AI_PROVIDER=mock`. Optional provider-compatible variables are documented in `.env.example`. Production secrets belong in the hosted secret manager, never source control.

## Database and seed data

`npm run db:generate` generates D1 migrations from `db/schema.ts`. The interactive product includes fictional Northstar Pest data for the Huntley, Crystal Lake, Algonquin, and Lake in the Hills operating area. API writes create attributable audit, outbox, and evidence records on demand.

## Troubleshooting

- If the dev port is occupied, the server selects another local port.
- If an evidence upload is offline, the technician draft remains in IndexedDB and the UI marks it queued for retry.
- If schema bindings are missing, confirm `.openai/hosting.json` declares `DB` and `EVIDENCE`.
- If a build changed dependencies, run `npm install` to refresh the lockfile.

## Production considerations

This is a production-capable MVP vertical slice, not the full enterprise scope. Before live customer use, complete the controls in [deployment](docs/deployment.md) and [threat model](docs/threat-model.md), implement full organization membership lifecycle and provider adapters, add durable queue infrastructure, expand integration/security/E2E coverage, and perform formal security/accessibility/legal reviews.
