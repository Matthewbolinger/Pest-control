# API

The API is versioned under `/api/v1`. The generated OpenAPI document is
available at `/api/v1/openapi`.

## Implemented endpoints

- `GET /api/v1/version` — unauthenticated build and source fingerprint with
  no-store headers.
- `GET /api/v1/me` — active database-backed organization membership, role,
  technician link, and explicit permissions.
- `GET /api/v1/operations` — tenant-scoped normalized customer, property,
  request, job, confirmed appointment, playbook, evidence policy, economics,
  outcome, proof, and integration projections for the active pilot job.
- `GET /api/v1/health` — workflow, outbox, dead-letter, verification,
  proof-delivery, integration, and build state.
- `GET /api/v1/workflow` — load or initialize the authenticated tenant's
  optimistic, versioned Huntley workflow.
- `POST /api/v1/workflow` — apply an ordered, authorized, idempotent workflow
  command with optimistic version enforcement.
- `GET /api/v1/audit` — authenticated, tenant-scoped authoritative audit trace.
- `GET /api/v1/evidence?id=…` — authorized retrieval of a private evidence
  object.
- `POST /api/v1/evidence` — typed JPEG/PNG/WebP upload with real-byte content
  detection, size validation, SHA-256 integrity metadata, assignment and
  relationship checks, capture semantics, D1 metadata, and private R2 bytes.
- `GET /api/v1/integrations` — connection, capability, sync, reconciliation,
  and open-error state.
- `POST /api/v1/integrations` — idempotent deterministic mock shadow sync. It
  does not call or claim compatibility with a live vendor API.
- `GET /api/v1/outbox` — proof-delivery and durable outbox state.
- `POST /api/v1/outbox` — claim and process one pending proof delivery with the
  deterministic mock communications adapter.

## Workflow truth

Workflow commands never accept tenant or actor authority fields. The server
derives both from trusted identity and the active database membership. Role
permissions and assigned-technician checks are applied before mutations.

`COMPLETE_JOB` records actual inputs, applies the configured completion policy,
generates Service Proof, and sets the outcome to `PENDING_VERIFICATION`. It
never records resolution. `VERIFY_OUTCOME` is a distinct permissioned action
with source, note, authenticated verifier, and timestamp. The field completer
cannot verify the same job. The interactive pilot records
`STAFF_RECORDED_CUSTOMER_CONFIRMATION`; the direct
`CUSTOMER_CONFIRMATION` source is rejected until a trusted customer or
communications-provider receipt exists. `RECORD_RESERVICE` creates a distinct,
same-tenant child job linked to the original and recalculates final economics.

`SEND_PROOF` creates a durable delivery request and remains `QUEUED` until the
outbox processor receives a provider result. In the pilot the provider is
deterministic and mocked; production channel delivery is not implemented.
Processing reserves the operation identifier before claiming work, and
every claim, release, recovery, and finalization is fenced by the exact receipt
lease. A successful delivery receipt is not finalized until the provider result
is durable and the workflow projection has a concrete applied version.

## Mutation and error contract

JSON mutations require `application/json`; evidence uses multipart form data.
Workflow, integration, outbox, and evidence writes use stable idempotency keys.
Cross-site mutations are rejected. Workflow changes additionally require the
current expected version.

Errors include a machine-readable `code`, human-readable `message`, and
`correlationId`. Validation and authorization failures do not leak another
tenant's state.

The current route inventory is production-shaped but pilot-scoped: it operates
the seeded Huntley workflow and mock integration/delivery paths. Live vendor,
communications, and multi-job production endpoints remain external-gate work.
