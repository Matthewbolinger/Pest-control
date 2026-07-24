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
  verificationIntervalDays: integer("verification_interval_days")
    .notNull()
    .default(7),
  proofDeliveryMode: text("proof_delivery_mode").notNull().default("MOCK"),
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
  status: text("status").notNull().default("ACTIVE"),
  ...auditColumns,
}, (table) => [uniqueIndex("users_email_idx").on(table.email)]);

export const memberships = sqliteTable("organization_memberships", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
  technicianId: text("technician_id"),
  status: text("status").notNull().default("ACTIVE"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("memberships_tenant_user_idx").on(
    table.organizationId,
    table.userId,
  ),
]);

export const technicians = sqliteTable("technicians", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  branchId: text("branch_id").notNull(),
  userId: text("user_id"),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  laborCostPerHourCents: integer("labor_cost_per_hour_cents")
    .notNull()
    .default(0),
  skillsJson: text("skills_json").notNull().default("[]"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("technicians_tenant_user_idx").on(
    table.organizationId,
    table.userId,
  ),
]);

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  contactPolicy: text("contact_policy").notNull().default("SMS_ALLOWED"),
  email: text("email"),
  phone: text("phone"),
  status: text("status").notNull().default("ACTIVE"),
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
  recurringPlanStatus: text("recurring_plan_status")
    .notNull()
    .default("ACTIVE"),
  openRisksJson: text("open_risks_json").notNull().default("[]"),
  nextInspectionAt: integer("next_inspection_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("ACTIVE"),
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
  triageJson: text("triage_json"),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }),
  createdByUserId: text("created_by_user_id"),
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
  requiredEvidenceJson: text("required_evidence_json")
    .notNull()
    .default("[]"),
  aftercareJson: text("aftercare_json").notNull().default("[]"),
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
  kind: text("kind").notNull().default("ORIGINAL"),
  parentJobId: text("parent_job_id"),
  priceCents: integer("price_cents").notNull().default(0),
  actualDriveMinutes: integer("actual_drive_minutes"),
  actualMaterialCostCents: integer("actual_material_cost_cents"),
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
  phase: text("phase").notNull().default("DURING"),
  subject: text("subject").notNull().default("OTHER"),
  caption: text("caption"),
  uploadedByUserId: text("uploaded_by_user_id"),
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
  ownerUserId: text("owner_user_id"),
  resolutionNote: text("resolution_note"),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  ...auditColumns,
});

export const serviceOutcomes = sqliteTable("service_outcomes", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  status: text("status").notNull(),
  recurrenceRiskScore: integer("recurrence_risk_score").notNull(),
  explanationJson: text("explanation_json").notNull(),
  technicianAssessment: text("technician_assessment")
    .notNull()
    .default("UNKNOWN"),
  observationWindowEndsAt: integer("observation_window_ends_at", {
    mode: "timestamp_ms",
  }),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
  verifiedByUserId: text("verified_by_user_id"),
  verificationSource: text("verification_source"),
  verificationNote: text("verification_note"),
  ...auditColumns,
});

export const outcomeCheckpoints = sqliteTable("outcome_checkpoints", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  propertyId: text("property_id").notNull(),
  dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
  status: text("status").notNull().default("PENDING"),
  result: text("result"),
  source: text("source"),
  note: text("note"),
  verifiedByUserId: text("verified_by_user_id"),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  idempotencyKey: text("idempotency_key").notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex("outcome_checkpoints_tenant_idempotency_idx").on(
    table.organizationId,
    table.idempotencyKey,
  ),
]);

export const reserviceEvents = sqliteTable("reservice_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  originalJobId: text("original_job_id").notNull(),
  reserviceJobId: text("reservice_job_id").notNull(),
  reason: text("reason").notNull(),
  costCents: integer("cost_cents").notNull().default(0),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex("reservice_events_tenant_job_idx").on(
    table.organizationId,
    table.reserviceJobId,
  ),
]);

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
  revenueCents: integer("revenue_cents").notNull().default(0),
  laborMinutes: integer("labor_minutes").notNull().default(0),
  laborCostCents: integer("labor_cost_cents").notNull().default(0),
  driveMinutes: integer("drive_minutes").notNull().default(0),
  driveCostCents: integer("drive_cost_cents").notNull().default(0),
  materialCostCents: integer("material_cost_cents").notNull().default(0),
  expectedReserviceCostCents: integer("expected_reservice_cost_cents")
    .notNull()
    .default(0),
  actualReserviceCostCents: integer("actual_reservice_cost_cents")
    .notNull()
    .default(0),
  contributionMarginCents: integer("contribution_margin_cents")
    .notNull()
    .default(0),
  sourceJson: text("source_json").notNull().default("{}"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("margin_snapshots_tenant_job_phase_idx").on(
    table.organizationId,
    table.jobId,
    table.phase,
  ),
]);

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
  ownerUserId: text("owner_user_id"),
  resolutionNote: text("resolution_note"),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
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
  lastError: text("last_error"),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  ...auditColumns,
}, (table) => [uniqueIndex("outbox_idempotency_idx").on(table.idempotencyKey)]);

export const proofDeliveries = sqliteTable("proof_deliveries", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  reportId: text("report_id").notNull(),
  channel: text("channel").notNull(),
  recipient: text("recipient").notNull(),
  status: text("status").notNull(),
  providerMessageId: text("provider_message_id"),
  failureReason: text("failure_reason"),
  queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  idempotencyKey: text("idempotency_key").notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex("proof_deliveries_tenant_idempotency_idx").on(
    table.organizationId,
    table.idempotencyKey,
  ),
]);

export const serviceProofs = sqliteTable("service_proofs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  jobId: text("job_id").notNull(),
  revision: integer("revision").notNull().default(1),
  canonicalJson: text("canonical_json").notNull(),
  sha256: text("sha256").notNull(),
  generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
  generatedByUserId: text("generated_by_user_id").notNull(),
  status: text("status").notNull().default("GENERATED"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("service_proofs_tenant_job_revision_idx").on(
    table.organizationId,
    table.jobId,
    table.revision,
  ),
]);

export const integrationConnections = sqliteTable("integration_connections", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  provider: text("provider").notNull(),
  mode: text("mode").notNull().default("SHADOW_READ_ONLY"),
  status: text("status").notNull().default("CONNECTED"),
  capabilitiesJson: text("capabilities_json").notNull().default("[]"),
  lastSuccessfulSyncAt: integer("last_successful_sync_at", {
    mode: "timestamp_ms",
  }),
  ...auditColumns,
}, (table) => [
  uniqueIndex("integration_connections_tenant_provider_idx").on(
    table.organizationId,
    table.provider,
  ),
]);

export const integrationSyncs = sqliteTable("integration_syncs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  connectionId: text("connection_id").notNull(),
  direction: text("direction").notNull(),
  status: text("status").notNull(),
  cursor: text("cursor"),
  importedCount: integer("imported_count").notNull().default(0),
  exportedCount: integer("exported_count").notNull().default(0),
  sourceCount: integer("source_count").notNull().default(0),
  reconciledCount: integer("reconciled_count").notNull().default(0),
  attempt: integer("attempt").notNull().default(1),
  requestJson: text("request_json").notNull().default("{}"),
  resultJson: text("result_json").notNull().default("{}"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  idempotencyKey: text("idempotency_key").notNull(),
  errorSummary: text("error_summary"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("integration_syncs_tenant_idempotency_idx").on(
    table.organizationId,
    table.idempotencyKey,
  ),
]);

export const integrationSyncErrors = sqliteTable("integration_sync_errors", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  syncId: text("sync_id").notNull(),
  externalRecordType: text("external_record_type").notNull(),
  externalRecordId: text("external_record_id"),
  code: text("code").notNull(),
  message: text("message").notNull(),
  retryable: integer("retryable", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("OPEN"),
  ...auditColumns,
});

export const externalIdMappings = sqliteTable("external_id_mappings", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  connectionId: text("connection_id").notNull(),
  entityType: text("entity_type").notNull(),
  internalId: text("internal_id").notNull(),
  externalId: text("external_id").notNull(),
  externalVersion: text("external_version"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("external_mappings_tenant_external_idx").on(
    table.organizationId,
    table.connectionId,
    table.entityType,
    table.externalId,
  ),
  uniqueIndex("external_mappings_tenant_internal_idx").on(
    table.organizationId,
    table.connectionId,
    table.entityType,
    table.internalId,
  ),
]);

export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  connectionId: text("connection_id").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  createdCount: integer("created_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  quarantinedCount: integer("quarantined_count").notNull().default(0),
  cursor: text("cursor"),
  committedAt: integer("committed_at", { mode: "timestamp_ms" }),
  rolledBackAt: integer("rolled_back_at", { mode: "timestamp_ms" }),
  ...auditColumns,
}, (table) => [
  uniqueIndex("import_batches_tenant_source_idx").on(
    table.organizationId,
    table.connectionId,
    table.sourceSha256,
    table.mode,
  ),
]);

export const syncOperationReceipts = sqliteTable("sync_operation_receipts", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  operationId: text("operation_id").notNull(),
  operationType: text("operation_type").notNull(),
  requestJson: text("request_json").notNull(),
  responseJson: text("response_json").notNull(),
  status: text("status").notNull(),
  appliedVersion: integer("applied_version"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("sync_operation_receipts_tenant_operation_idx").on(
    table.organizationId,
    table.operationId,
  ),
]);

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
