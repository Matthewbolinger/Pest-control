# Integration guide

Provider-neutral contracts live in `packages/integrations`.

- `FSMAdapter`: customers, properties, technicians, jobs, appointment write-back, completion write-back.
- `MapsAdapter`: deterministic drive-time inputs.
- `WeatherAdapter`: operational advisories only.
- `CommunicationsAdapter`: report and follow-up delivery.
- `ObjectStorageAdapter`: private evidence upload/retrieval.

The mock FSM adapter is idempotent and allows the demo to run without credentials. A real provider should authenticate through organization-scoped secrets, map external IDs in an integration table, validate webhooks, store idempotency keys, use the outbox for write-back, expose sync status, and route permanent failures to a human-owned exception.

Do not scrape external systems.
