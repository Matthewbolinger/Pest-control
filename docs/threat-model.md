# Threat model

## Assets

Tenant records, customer/property data, evidence objects, authenticated
identity, organization memberships, technician assignments, playbooks,
prices/costs, schedule decisions, offline drafts and attachments, audit history,
integration credentials, provider receipts, and Service Proof.

## Trust boundaries

Browser ↔ application API; browser ↔ IndexedDB/service worker; API ↔ D1/R2;
provider adapters ↔ external systems; untrusted field/customer/import content ↔
AI provider; trusted hosted identity ↔ database membership.

## Implemented controls

- **Tenant isolation:** server-derived organization and actor, active
  database-backed membership, organization IDs on tenant records, strict
  schemas, relationship validation, and no client-authoritative tenant/actor
  selection.
- **Authorization:** default-deny role permissions and assigned-technician
  enforcement for field reads, writes, uploads, and completion.
- **Cross-site writes:** JSON-only workflow/integration/outbox commands,
  matching body/header idempotency keys, origin and Fetch Metadata checks, and a
  required custom header for evidence uploads.
- **Evidence:** size checks, magic-byte type detection, random tenant-scoped
  object keys, stable idempotency, SHA-256 metadata, assignment and relational
  checks, private R2, authenticated retrieval, and cleanup after failed metadata
  persistence.
- **Prompt injection:** untrusted-content separation, schema validation,
  allowlisted actions, deterministic policy, post-model authorization, and
  human approval for material actions.
- **Audit and replay:** server-derived actors, correlation IDs, optimistic
  workflow versions, idempotent receipts, append-only audit events, and durable
  outbox records.
- **Delivery truth:** queued and delivered are distinct; processing uses claim
  state, retry classification, receipts, and visible dead-letter state.
- **Offline privacy:** journals are scoped by organization, actor, and job;
  replay rechecks server authorization; personalized HTML, APIs, auth routes,
  and evidence are never cached by the service worker; sign-out purges caches
  and local databases; cold offline navigation is a neutral page.
- **Offline integrity:** append-before-network operation and attachment
  persistence, explicit dependencies, stable IDs, leases, compare-and-swap
  updates, monotonic server versions, backoff, auth blocking, and human recovery
  states.
- **Integration truth:** explicit capability matrix, local-only mock/CSV
  verification, per-item outcomes, reconciliation counts, retry ceilings, and
  vendor capabilities marked credential-gated.

## Residual and external-gate risks

- The private pilot auto-provisions its hosted owner. Shared deployment still
  needs invitation, role administration, suspension/removal UX, access review,
  session policy, and organization-scoped secret management.
- The deterministic communications adapter and on-demand processor are not a
  production sender or scheduled worker.
- Live vendor auth, webhook signatures, rate limits, reconciliation, and
  write-back have not been exercised against vendor sandboxes.
- IndexedDB is device-local data. Production requires a documented retention
  window, device-loss policy, support recovery path, and validation on the
  supported browser/device fleet.
- Evidence needs production malware scanning, retention/deletion automation,
  and jurisdiction/customer policy.
- Centralized security logs, managed WAF/rate limits, alerting, backup/restore,
  disaster recovery, and independent penetration testing remain unverified.
- Risk and verification policies are deterministic pilot heuristics, not
  calibrated outcome claims.

## Threat actors

Unauthenticated internet users, compromised customer or employee accounts,
malicious imported content, misconfigured integrations, over-privileged
insiders, lost/shared technician devices, replaying clients, and accidental
operator error.

## Required production review

Independent penetration and tenant-isolation testing; CSP and secure-header
review; secrets manager and rotation; managed WAF/rate limiting; malware
scanning; centralized alerting; backup/restore and disaster-recovery drills;
privacy, retention, deletion, accessibility, and legal review; customer consent
and communications compliance; and formal incident response.
