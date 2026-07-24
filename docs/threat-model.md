# Threat model

## Assets

Tenant records, customer/property data, evidence objects, authentication sessions, playbooks, prices/costs, schedule decisions, audit history, integration credentials, and reports.

## Trust boundaries

Browser ↔ application API; API ↔ D1/R2; provider adapters ↔ external systems; untrusted field/customer content ↔ AI provider; authenticated identity ↔ organization membership.

## Priority threats and controls

- **Tenant isolation:** server-derived organization scope, membership checks, organization ID on tenant records, cross-tenant tests, no client-authoritative tenant selection.
- **Prompt injection:** untrusted-content separation, schema validation, allowlisted actions, deterministic policy, post-model authorization.
- **File upload:** strict MIME/size checks, random object keys, SHA-256 metadata, private R2, signed retrieval, production malware scanning and content sniffing.
- **Authorization:** platform authentication, role/permission services, server-side checks, short sessions, SameSite/HTTP-only cookies where app sessions are added.
- **Integration:** scoped secrets, idempotency keys, signature validation, retry ceilings, dead-letter review, sync audit events.
- **Audit integrity:** append-only records, restricted delete rights, correlation IDs, outbox delivery, production log export/WORM retention.
- **Privacy:** minimum necessary fields, retention controls, signed evidence access, no facial recognition or protected-attribute inference.

## Threat actors

Unauthenticated internet users, compromised customer/employee accounts, malicious imported content, misconfigured integrations, over-privileged insiders, and accidental operator error.

## Recommended production controls

Independent penetration test, database row-level isolation review, CSP and secure headers, secrets manager, managed WAF/rate limiting, malware scanning, KMS-backed encryption, centralized alerting, backup/restore drills, legal retention review, and formal incident response.
