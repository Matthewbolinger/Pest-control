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
  ORGANIZATION ||--o{ AUDIT_EVENT : retains
```

The migration implements the vertical-slice records: organizations, branches, users, memberships, customers, properties and zones, service requests, immutable playbook versions, jobs, appointments, schedule candidates, observations, evidence, outcomes, follow-ups, margin snapshots, exceptions, proposals, audit, and outbox events.

Future normalized additions include technician availability/skills, territories, pricebook and cost profiles, route plans, notifications, integration connections and syncs, explicit approvals, recurring plans, and retention cohorts.
