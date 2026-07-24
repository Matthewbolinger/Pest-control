# Integration guide

FieldProof is the assurance layer beside an FSM. Customer, property, contract,
appointment, route, price, invoice, payment, payroll, and regulatory treatment
authority remain in the connected system of record. FieldProof imports enough
context to assure a visit and can return evidence-backed outcome/proof state only
through explicitly authorized adapter capabilities.

Provider-neutral contracts live in `packages/integrations`.

## Implemented local capability

- A strict capability matrix covers `MOCK`, `CSV`, `FIELDROUTES`, `PESTPAC`,
  and `GORILLADESK`.
- Mock and CSV behavior is locally verified.
- Batch sync returns a cursor, totals, and an outcome for every input record:
  created, updated, skipped, quarantined, or failed.
- Stable idempotency keys, retryable/final error classification, per-item
  reconciliation, and replay receipts are modeled.
- D1 stores connections, modes, capability declarations, external-ID mappings,
  import batches, sync runs, source/reconciled counts, cursors, and open errors.
- `/api/v1/integrations` exposes the current shadow connection and runs an
  idempotent deterministic mock reconciliation.
- The communications contract is exercised by the proof-delivery outbox. Only
  an adapter-confirmed receipt becomes `DELIVERED`.

The UI's **Integrations** surface is enabled and intentionally identifies
FieldRoutes, PestPac, and GorillaDesk as `REQUIRES_VENDOR_ACCESS`.

## Capability truth

The repository does not contain verified live FieldRoutes, PestPac, or
GorillaDesk adapters. Their remote operations, cursor behavior, webhooks,
idempotency, permissions, and rate limits cannot be asserted without current
vendor documentation, sandbox access, and scoped credentials.

The proof-delivery processor uses `MockCommunicationsAdapter` on demand. It
demonstrates claim, receipt, retry, final-failure, and dead-letter semantics; it
does not send customer email or SMS.

## Production adapter checklist

A live connector must:

1. Authenticate with organization-scoped secrets that never reach the client,
   logs, audit values, or source control.
2. Declare only capabilities verified against the current vendor environment.
3. Map external and internal IDs with source version/fingerprint provenance.
4. Validate webhook authenticity, freshness, replay, and tenant ownership.
5. Use incremental cursors where supported and preserve the last safe
   checkpoint.
6. Return a deterministic outcome for every record and quarantine invalid
   inputs without hiding partial success.
7. Reconcile source count, processed count, and resulting state before
   advancing a cursor.
8. Reuse stable idempotency keys for retries and record provider receipts.
9. Classify retryable and permanent failures, cap retries, and expose
   dead-letter records with human ownership.
10. Start read-only in shadow mode. Any appointment, completion, proof, or
    outcome write-back requires explicit partner authorization and comparison
    against the vendor system after write.

Production communications additionally require approved sender identity,
templates, consent/opt-out rules, delivery/bounce webhooks, privacy review, and
a scheduled outbox worker.

Do not scrape external systems or infer undocumented capabilities.
