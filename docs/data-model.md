# Data model

```mermaid
erDiagram
  ORGANIZATION ||--o{ BRANCH : owns
  ORGANIZATION ||--o{ MEMBERSHIP : authorizes
  CUSTOMER ||--o{ PROPERTY : owns
  PROPERTY ||--o{ PROPERTY_ZONE : contains
  PROPERTY ||--o{ SERVICE_REQUEST : receives
  SERVICE_REQUEST ||--o| JOB : becomes
  JOB }o--|| PLAYBOOK_VERSION : follows
  JOB ||--o{ OBSERVATION : records
  JOB ||--o{ EVIDENCE_ASSET : proves
  JOB ||--o| SERVICE_OUTCOME : measures
  JOB ||--o{ FOLLOW_UP : creates
  JOB ||--o{ MARGIN_SNAPSHOT : values
  JOB ||--|| WORKFLOW_SNAPSHOT : projects
  WORKFLOW_SNAPSHOT ||--o{ WORKFLOW_COMMAND_RECEIPT : records
  ORGANIZATION ||--o{ AUDIT_EVENT : retains
  ORGANIZATION ||--o{ OUTBOX_EVENT : queues
```

The migrations implement the vertical-slice records: organizations, branches, users, memberships, customers, properties and zones, service requests, immutable playbook versions, jobs, appointments, schedule candidates, observations, evidence, outcomes, follow-ups, margin snapshots, exceptions, proposals, audit, outbox events, versioned workflow snapshots, and idempotent command receipts.

For the current pilot, the workflow snapshot is the server-authoritative projection used by the UI. The normalized outcome, margin, follow-up, evidence, audit, and outbox records are written alongside it. IndexedDB holds only a browser cache and clearly marked offline drafts; it is not an authoritative data store.

Future normalized additions include technician availability/skills, territories, pricebook and cost profiles, route plans, notifications, integration connections and syncs, explicit approvals, recurring plans, and retention cohorts.
