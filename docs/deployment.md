# Deployment

FieldProof targets Cloudflare Workers through Vinext, with D1 for relational
operational state and R2 for private evidence objects. The Sites project and
logical `DB`/`EVIDENCE` bindings are declared in `.openai/hosting.json`.
Checked-in Drizzle migrations must be applied before serving a new version.

## Release controls

1. Run the repository verification gates:

   ```bash
   npm run lint
   npm run typecheck
   npm run test
   npm run evals
   npm run build
   npm run test:artifact
   npm run test:e2e
   ```

2. Push the exact source state that will be packaged.
3. Build with `FIELDPROOF_BUILD_SHA` set to that immutable commit SHA.
4. Save and deploy only the version produced from that pushed state.
5. Verify `/api/v1/version`, `/api/v1/health`, and the document
   `data-build-sha` report the expected fingerprint.
6. Verify access remains private and D1/R2 bindings, migrations, evidence
   retrieval, and the full request-to-verification workflow operate in the
   deployed environment.

The PWA invalidates public shell caches when the build fingerprint changes.
Authenticated pages, APIs, auth routes, and evidence remain network-only.

## Repository-controlled capability

The deployed pilot can use:

- database-backed membership RBAC and assignment checks;
- server-authoritative workflow, evidence, proof, verification, reservice, and
  economics records;
- the actor-scoped offline journal and secure neutral cold-offline fallback;
- a deterministic mock FSM shadow sync with persisted reconciliation; and
- durable proof delivery processed on demand through a deterministic mock
  communications adapter.

Mock delivery and mock sync are observability and contract demonstrations. They
must not be configured or marketed as live customer/vendor integrations.

## External production gates

Before external customer traffic, complete and document:

- named design-partner owners, pilot scope, baseline, observation windows,
  consent, and success/stop criteria;
- actual FSM documentation, sandbox tenants, scoped credentials, webhook
  validation, rate-limit handling, reconciliation, and authorized write-back;
- a production email/SMS provider, approved sender/templates, opt-out handling,
  delivery webhooks, and proof/verification consent;
- shared-tenant membership invitation, role administration, suspension,
  removal, and organization-scoped secret management;
- managed WAF/rate limits, secure headers, malware scanning, centralized logs
  and alerts, incident response, and penetration testing;
- privacy, evidence retention/deletion, accessibility, legal/regulatory, and
  data-processing reviews;
- automated backups, tested restoration, disaster-recovery objectives, and
  rollback/reconciliation runbooks; and
- risk, verification-window, and economic calibration on real field data.

A scheduled production outbox worker must replace the on-demand mock processor
before live proof delivery. No production feature may depend on mock AI, FSM,
or communications behavior.

The application services can later move to a dedicated API/worker topology
without moving deterministic calculations out of `packages/domain`.
