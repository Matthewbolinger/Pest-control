# Threat model

## Assets

Tenant records, customer/property data, evidence objects, authentication sessions, playbooks, prices/costs, schedule decisions, audit history, integration credentials, and reports.

## Trust boundaries

Browser ↔ application API; API ↔ D1/R2; provider adapters ↔ external systems; untrusted field/customer content ↔ AI provider; authenticated identity ↔ organization membership.

## Priority threats and controls

- **Tenant isolation:** custom Sites access policy, server-derived pilot organization scope, organization ID on tenant records, strict command schemas, and no client-authoritative tenant or actor selection. Full multi-organization membership resolution remains required before external customer use.
- **Prompt injection:** untrusted-content separation, schema validation, allowlisted actions, deterministic policy, post-model authorization.
- **File upload:** size checks, magic-byte content detection, random object keys, stable idempotency, SHA-256 metadata, assignment checks, private R2, authenticated tenant-scoped retrieval, cleanup after failed metadata persistence, and production malware scanning.
- **Authorization:** platform authentication, role/permission services, server-side checks, short sessions, SameSite/HTTP-only cookies where app sessions are added.
- **Cross-site writes:** JSON-only workflow commands, matching body/header idempotency keys, origin and Fetch Metadata checks, and a required custom header for evidence uploads.
- **Integration:** scoped secrets, idempotency keys, signature validation, retry ceilings, dead-letter review, sync audit events.
- **Audit integrity:** authoritative services emit append-only records with server-derived actors, correlation IDs, and idempotent outbox records. A production outbox consumer plus log export/WORM retention remain required.
- **Privacy:** minimum necessary fields, retention controls, signed evidence access, no facial recognition or protected-attribute inference.

## Threat actors

Unauthenticated internet users, compromised customer/employee accounts, malicious imported content, misconfigured integrations, over-privileged insiders, and accidental operator error.

## Recommended production controls

Independent penetration test, database row-level isolation review, CSP and secure headers, secrets manager, managed WAF/rate limiting, malware scanning, KMS-backed encryption, centralized alerting, backup/restore drills, legal retention review, and formal incident response.
