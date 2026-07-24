CREATE TABLE `workflow_command_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`command_id` text NOT NULL,
	`command_type` text NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text NOT NULL,
	`applied_version` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_receipts_tenant_command_idx` ON `workflow_command_receipts` (`organization_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `workflow_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_request_id` text NOT NULL,
	`job_id` text NOT NULL,
	`property_id` text NOT NULL,
	`assigned_technician_id` text,
	`snapshot_json` text NOT NULL,
	`last_command_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_snapshots_tenant_job_idx` ON `workflow_snapshots` (`organization_id`,`job_id`);--> statement-breakpoint
ALTER TABLE `evidence_assets` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_assets_tenant_idempotency_idx` ON `evidence_assets` (`organization_id`,`idempotency_key`);