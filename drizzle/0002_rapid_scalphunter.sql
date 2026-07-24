CREATE TABLE `external_id_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`internal_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_mappings_tenant_external_idx` ON `external_id_mappings` (`organization_id`,`connection_id`,`entity_type`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_mappings_tenant_internal_idx` ON `external_id_mappings` (`organization_id`,`connection_id`,`entity_type`,`internal_id`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`source_sha256` text NOT NULL,
	`created_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`quarantined_count` integer DEFAULT 0 NOT NULL,
	`cursor` text,
	`committed_at` integer,
	`rolled_back_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_batches_tenant_source_idx` ON `import_batches` (`organization_id`,`connection_id`,`source_sha256`,`mode`);--> statement-breakpoint
CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`mode` text DEFAULT 'SHADOW_READ_ONLY' NOT NULL,
	`status` text DEFAULT 'CONNECTED' NOT NULL,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`last_successful_sync_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_connections_tenant_provider_idx` ON `integration_connections` (`organization_id`,`provider`);--> statement-breakpoint
CREATE TABLE `integration_sync_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`sync_id` text NOT NULL,
	`external_record_type` text NOT NULL,
	`external_record_id` text,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`retryable` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integration_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`cursor` text,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`exported_count` integer DEFAULT 0 NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`reconciled_count` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`request_json` text DEFAULT '{}' NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`idempotency_key` text NOT NULL,
	`error_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_syncs_tenant_idempotency_idx` ON `integration_syncs` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `outcome_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`property_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`result` text,
	`source` text,
	`note` text,
	`verified_by_user_id` text,
	`completed_at` integer,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outcome_checkpoints_tenant_idempotency_idx` ON `outcome_checkpoints` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `proof_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`report_id` text NOT NULL,
	`channel` text NOT NULL,
	`recipient` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text,
	`failure_reason` text,
	`queued_at` integer NOT NULL,
	`delivered_at` integer,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proof_deliveries_tenant_idempotency_idx` ON `proof_deliveries` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `reservice_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`original_job_id` text NOT NULL,
	`reservice_job_id` text NOT NULL,
	`reason` text NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservice_events_tenant_job_idx` ON `reservice_events` (`organization_id`,`reservice_job_id`);--> statement-breakpoint
CREATE TABLE `service_proofs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`canonical_json` text NOT NULL,
	`sha256` text NOT NULL,
	`generated_at` integer NOT NULL,
	`generated_by_user_id` text NOT NULL,
	`status` text DEFAULT 'GENERATED' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_proofs_tenant_job_revision_idx` ON `service_proofs` (`organization_id`,`job_id`,`revision`);--> statement-breakpoint
CREATE TABLE `sync_operation_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`operation_type` text NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text NOT NULL,
	`status` text NOT NULL,
	`applied_version` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_operation_receipts_tenant_operation_idx` ON `sync_operation_receipts` (`organization_id`,`operation_id`);--> statement-breakpoint
CREATE TABLE `technicians` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`user_id` text,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`labor_cost_per_hour_cents` integer DEFAULT 0 NOT NULL,
	`skills_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `technicians_tenant_user_idx` ON `technicians` (`organization_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `customers` ADD `email` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `status` text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `evidence_assets` ADD `phase` text DEFAULT 'DURING' NOT NULL;--> statement-breakpoint
ALTER TABLE `evidence_assets` ADD `subject` text DEFAULT 'OTHER' NOT NULL;--> statement-breakpoint
ALTER TABLE `evidence_assets` ADD `caption` text;--> statement-breakpoint
ALTER TABLE `evidence_assets` ADD `uploaded_by_user_id` text;--> statement-breakpoint
ALTER TABLE `exception_records` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `exception_records` ADD `resolution_note` text;--> statement-breakpoint
ALTER TABLE `exception_records` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `follow_ups` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `follow_ups` ADD `resolution_note` text;--> statement-breakpoint
ALTER TABLE `follow_ups` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `kind` text DEFAULT 'ORIGINAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `parent_job_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `price_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `actual_drive_minutes` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `actual_material_cost_cents` integer;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `revenue_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `labor_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `labor_cost_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `drive_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `drive_cost_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `material_cost_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `expected_reservice_cost_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `actual_reservice_cost_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `contribution_margin_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `margin_snapshots` ADD `source_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `margin_snapshots_tenant_job_phase_idx` ON `margin_snapshots` (`organization_id`,`job_id`,`phase`);--> statement-breakpoint
ALTER TABLE `organization_memberships` ADD `technician_id` text;--> statement-breakpoint
ALTER TABLE `organization_memberships` ADD `status` text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_tenant_user_idx` ON `organization_memberships` (`organization_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `verification_interval_days` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `proof_delivery_mode` text DEFAULT 'MOCK' NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `processed_at` integer;--> statement-breakpoint
ALTER TABLE `playbook_versions` ADD `required_evidence_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `playbook_versions` ADD `aftercare_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `properties` ADD `recurring_plan_status` text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `properties` ADD `open_risks_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `properties` ADD `next_inspection_at` integer;--> statement-breakpoint
ALTER TABLE `properties` ADD `status` text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE `service_outcomes` ADD `technician_assessment` text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE `service_outcomes` ADD `observation_window_ends_at` integer;--> statement-breakpoint
ALTER TABLE `service_outcomes` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `service_outcomes` ADD `verified_by_user_id` text;--> statement-breakpoint
ALTER TABLE `service_outcomes` ADD `verification_source` text;--> statement-breakpoint
ALTER TABLE `service_outcomes` ADD `verification_note` text;--> statement-breakpoint
ALTER TABLE `service_requests` ADD `triage_json` text;--> statement-breakpoint
ALTER TABLE `service_requests` ADD `received_at` integer;--> statement-breakpoint
ALTER TABLE `service_requests` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'ACTIVE' NOT NULL;