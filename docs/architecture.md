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

The web app is a Cloudflare Worker-compatible ESM deployment. Business calculations live in `packages/domain`; provider contracts live in `packages/ai` and `packages/integrations`. Tenant-owned tables include `organization_id`. The API never trusts a client-supplied tenant without reconciling it to the authenticated membership.

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
  D --> E{"Completion gate"}
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
