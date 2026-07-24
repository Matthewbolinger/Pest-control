import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const auditColumns = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  version: integer("version").notNull().default(1),
};

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  autonomyLevel: text("autonomy_level").notNull().default("SUGGEST_ONLY"),
  ...auditColumns,
});

export const branches = sqliteTable("branches", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  territory: text("territory").notNull(),
  ...auditColumns,
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash"),
  ...auditColumns,
}, (table) => [uniqueIndex("users_email_idx").on(table.email)]);

export const memberships = sqliteTable("organization_memberships", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
  ...auditColumns,
});

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  contactPolicy: text("contact_policy").notNull().default("SMS_ALLOWED"),
  ...auditColumns,
});

export const properties = sqliteTable("properties", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  customerId: text("customer_id").notNull(),
  branchId: text("branch_id").notNull(),
  address: text("address").notNull(),
  propertyType: text("property_type").notNull(),
  completenessScore: integer("completeness_score").notNull(),
  recurrenceRiskScore: integer("recurrence_risk_score").notNull(),
  ...auditColumns,
});

export const propertyZones = sqliteTable("property_zones", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  name: text("name").notNull(),
  ...auditColumns,
});

export const serviceRequests = sqliteTable("service_requests", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  propertyId: text("property_id").notNull(),
  source: text("source").notNull(),
  description: text("description").notNull(),
  issueCategory: text("issue_category"),
  confidence: real("confidence"),
  serviceability: text("serviceability"),
  status: text("status").notNull(),
  ...auditColumns,
});

export const playbookVersions = sqliteTable("playbook_versions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  serviceType: text("service_type").notNull(),
  versionLabel: text("version_label").notNull(),
  status: text("status").notNull(),
  effectiveAt: integer("effective_at", { mode: "timestamp_ms" }),
  stepsJson: text("steps_json").notNull(),
  ...auditColumns,
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  serviceRequestId: text("service_request_id").notNull(),
  propertyId: text("property_id").notNull(),
  playbookVersionId: text("playbook_version_id").notNull(),
  technicianId: text("technician_id"),
  status: text("status").notNull(),
  checkedInAt: integer("checked_in_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  ...auditColumns,
});

export const appointments = sqliteTable("appointments", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  technicianId: text("technician_id").notNull(),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  ...auditColumns,
}, (table) => [uniqueIndex("appointments_idempotency_idx").on(table.idempotencyKey)]);

export const scheduleCandidates = sqliteTable("schedule_candidates", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  serviceRequestId: text("service_request_id").notNull(),
  technicianId: text("technician_id").notNull(),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
  expectedContribution: real("expected_contribution").notNull(),
  score: real("score").notNull(),
  explanationJson: text("explanation_json").notNull(),
  approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
  ...auditColumns,
});

export const observations = sqliteTable("observations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  propertyId: text("property_id").notNull(),
  zoneId: text("zone_id").notNull(),
  technicianId: text("technician_id").notNull(),
  category: text("category").notNull(),
  note: text("note").notNull(),
  unresolved: integer("unresolved", { mode: "boolean" }).notNull().default(false),
  ...auditColumns,
});

export const evidenceAssets = sqliteTable("evidence_assets", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  idempotencyKey: text("idempotency_key"),
  jobId: text("job_id").notNull(),
  propertyId: text("property_id").notNull(),
  zoneId: text("zone_id").notNull(),
  technicianId: text("technician_id").notNull(),
  objectKey: text("object_key").notNull(),
  kind: text("kind").notNull(),
  contentType: text("content_type").notNull(),
  sha256: text("sha256").notNull(),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex("evidence_assets_tenant_idempotency_idx").on(
    table.organizationId,
    table.idempotencyKey,
  ),
]);

export const followUps = sqliteTable("follow_ups", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  propertyId: text("property_id").notNull(),
  dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  ...auditColumns,
});

export const serviceOutcomes = sqliteTable("service_outcomes", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  status: text("status").notNull(),
  recurrenceRiskScore: integer("recurrence_risk_score").notNull(),
  explanationJson: text("explanation_json").notNull(),
  ...auditColumns,
});

export const marginSnapshots = sqliteTable("margin_snapshots", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  phase: text("phase").notNull(),
  revenue: real("revenue").notNull(),
  laborCost: real("labor_cost").notNull(),
  driveCost: real("drive_cost").notNull(),
  materialCost: real("material_cost").notNull(),
  expectedReserviceCost: real("expected_reservice_cost").notNull(),
  contributionMargin: real("contribution_margin").notNull(),
  ...auditColumns,
});

export const exceptionRecords = sqliteTable("exception_records", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id"),
  type: text("type").notNull(),
  severity: text("severity").notNull(),
  reason: text("reason").notNull(),
  confidence: real("confidence").notNull(),
  financialImpact: real("financial_impact"),
  status: text("status").notNull(),
  ...auditColumns,
});

export const actionProposals = sqliteTable("action_proposals", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  actionType: text("action_type").notNull(),
  targetEntityType: text("target_entity_type").notNull(),
  targetEntityId: text("target_entity_id").notNull(),
  riskLevel: text("risk_level").notNull(),
  confidence: real("confidence").notNull(),
  requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull(),
  status: text("status").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  payloadJson: text("payload_json").notNull(),
  ...auditColumns,
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  correlationId: text("correlation_id").notNull(),
  reason: text("reason").notNull(),
  modelVersion: text("model_version"),
  policyVersion: text("policy_version"),
  previousJson: text("previous_json"),
  nextJson: text("next_json"),
});

export const outboxEvents = sqliteTable("outbox_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  eventType: text("event_type").notNull(),
  entityId: text("entity_id").notNull(),
  payloadJson: text("payload_json").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
  ...auditColumns,
}, (table) => [uniqueIndex("outbox_idempotency_idx").on(table.idempotencyKey)]);

export const workflowSnapshots = sqliteTable("workflow_snapshots", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  serviceRequestId: text("service_request_id").notNull(),
  jobId: text("job_id").notNull(),
  propertyId: text("property_id").notNull(),
  assignedTechnicianId: text("assigned_technician_id"),
  snapshotJson: text("snapshot_json").notNull(),
  lastCommandId: text("last_command_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  version: integer("version").notNull().default(1),
}, (table) => [
  uniqueIndex("workflow_snapshots_tenant_job_idx").on(
    table.organizationId,
    table.jobId,
  ),
]);

export const workflowCommandReceipts = sqliteTable("workflow_command_receipts", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  commandId: text("command_id").notNull(),
  commandType: text("command_type").notNull(),
  requestJson: text("request_json").notNull(),
  responseJson: text("response_json").notNull(),
  appliedVersion: integer("applied_version").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("workflow_receipts_tenant_command_idx").on(
    table.organizationId,
    table.commandId,
  ),
]);
