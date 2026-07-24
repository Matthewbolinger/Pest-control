# API

The API is versioned under `/api/v1`. The running OpenAPI document is available at `/api/v1/openapi`.

Implemented endpoints:

- `GET /api/v1/health` — service and queue state.
- `GET /api/v1/workflow` — load or initialize the authenticated tenant's versioned Huntley workflow.
- `POST /api/v1/workflow` — apply an ordered, idempotent workflow command with optimistic version enforcement.
- `GET /api/v1/audit` — authenticated, tenant-scoped authoritative audit trace.
- `GET /api/v1/evidence?id=…` — authorized private evidence retrieval.
- `POST /api/v1/evidence` — JPEG/PNG/WebP upload with real-byte content detection, size validation, SHA-256 integrity metadata, stable idempotency, assignment checks, tenant/job/property/zone/technician attribution, D1 metadata, and R2 bytes.

Errors include `code`, human-readable `message`, and `correlationId`. Validation failures do not leak internal state.

Workflow commands never accept tenant or actor fields. Identity is derived from trusted platform headers, with a localhost-only fictional identity for development. The production API expansion follows the route inventory in the master product brief.
