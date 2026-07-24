# API

The API is versioned under `/api/v1`. The running OpenAPI document is available at `/api/v1/openapi`.

Implemented endpoints:

- `GET /api/v1/health` — service and queue state.
- `GET /api/v1/audit` — tenant-scoped audit trace.
- `POST /api/v1/audit` — validated immutable event plus outbox record.
- `POST /api/v1/evidence` — JPEG/PNG/WebP evidence upload with file-size validation, SHA-256 integrity metadata, tenant/job/property/zone/technician attribution, and R2 storage.

Errors include `code`, human-readable `message`, and `correlationId`. Validation failures do not leak internal state.

The production API expansion follows the route inventory in the master product brief. Route handlers must call tenant-scoped application services rather than query across organizations.
