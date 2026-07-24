# Architecture

```mermaid
flowchart LR
  UI["Vinext / React operations UI"] --> API["Versioned application services"]
  API --> POLICY["Deterministic policy + domain"]
  API --> AI["AIProvider boundary"]
  API --> DB["D1 tenant-scoped records"]
  API --> R2["R2 evidence objects"]
  API --> OUTBOX["Outbox events"]
  OUTBOX --> WORKER["Idempotent background handlers"]
  API --> ADAPTERS["FSM / maps / weather / communications adapters"]
```

The web app is a Cloudflare Worker-compatible ESM deployment. Business calculations live in `packages/domain`; the server workflow state machine lives in `packages/application`; provider contracts live in `packages/ai` and `packages/integrations`. Tenant-owned tables include `organization_id`. Workflow and evidence APIs derive the pilot tenant and actor from trusted platform identity and reject client-supplied authority fields.

The Huntley pilot uses a D1 workflow snapshot with optimistic versioning, stable command identifiers, replay receipts, authoritative audit events, and outbox records. Browser state is a cache or explicitly unconfirmed offline draft; it is never sufficient to complete a job or generate Service Proof.

## Service request workflow

```mermaid
flowchart LR
  A["Untrusted customer message"] --> B["Validated AI extraction"]
  B --> C["Deterministic serviceability policy"]
  C --> D["Human triage approval"]
  D --> E["Eligible schedule candidates"]
  E --> F["Human slot approval"]
```

## Job completion workflow

```mermaid
flowchart LR
  A["Check in"] --> B["Approved playbook"]
  B --> C["Checklist + observations"]
  C --> D["Evidence ledger"]
  D --> E{"Server completion gate"}
  E -->|Pass| F["Service Proof"]
  E -->|Open risk| G["Follow-up + exception"]
  F --> H["Outcome + margin + property update"]
```

## AI action approval

```mermaid
flowchart TD
  A["Narrow AI proposal"] --> B["Zod validation"]
  B --> C["Tenant + permission check"]
  C --> D["Policy version evaluation"]
  D --> E{"Approval required?"}
  E -->|Yes| F["Human approve / reject"]
  E -->|No, configured low risk| G["Typed service executes"]
  F --> G
  G --> H["Audit + outbox"]
```

## Current production boundary

The request-to-proof pilot is implemented end to end. Playbooks, broad analytics, organization settings, the complete role lifecycle, and the outbox consumer remain intentionally unavailable until the pilot path is verified. D1/R2 remain appropriate for this phase; splitting into Fastify/PostgreSQL workers is not required to establish server authority.
