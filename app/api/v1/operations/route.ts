import { env } from "cloudflare:workers";
import {
  authorizePermission,
  contextDenied,
  getRequestContext,
} from "@/app/api/v1/request-context";
import { PILOT_RECORDS } from "@/app/api/v1/pilot-data";

type JobRow = {
  id: string;
  technician_id: string | null;
};

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  try {
    const resolution = await getRequestContext(request, env.DB);
    if (!resolution.context) return contextDenied(resolution, correlationId);
    const context = resolution.context;

    const job = await env.DB.prepare(
      `SELECT id, technician_id FROM jobs
       WHERE organization_id = ? AND id = ?`,
    )
      .bind(context.organizationId, PILOT_RECORDS.jobId)
      .first<JobRow>();
    if (!job) {
      return Response.json(
        {
          error: {
            code: "JOB_NOT_FOUND",
            message: "The requested job was not found.",
            correlationId,
          },
        },
        { status: 404 },
      );
    }
    const officeDenied = authorizePermission(
      context,
      "JOB_READ_ALL",
      correlationId,
    );
    if (officeDenied) {
      const assignedDenied = authorizePermission(
        context,
        "JOB_READ_ASSIGNED",
        correlationId,
        job.technician_id,
      );
      if (assignedDenied) return assignedDenied;
    }

    const [
      organization,
      branch,
      customer,
      property,
      zones,
      serviceRequest,
      jobDetail,
      appointment,
      playbook,
      candidates,
      observations,
      margins,
      outcome,
      checkpoints,
      followUps,
      proof,
      deliveries,
      connection,
      syncs,
    ] = await Promise.all([
      first(
        `SELECT id, name, autonomy_level, verification_interval_days,
                proof_delivery_mode, version
         FROM organizations WHERE id = ?`,
        [context.organizationId],
      ),
      first(
        `SELECT id, name, territory, version FROM branches
         WHERE organization_id = ? AND id = ?`,
        [context.organizationId, PILOT_RECORDS.primaryBranchId],
      ),
      first(
        `SELECT id, name, contact_policy, email, phone, status, version
         FROM customers WHERE organization_id = ? AND id = ?`,
        [context.organizationId, PILOT_RECORDS.customerId],
      ),
      first(
        `SELECT id, customer_id, branch_id, address, property_type,
                completeness_score, recurrence_risk_score,
                recurring_plan_status, open_risks_json, next_inspection_at,
                status, version
         FROM properties WHERE organization_id = ? AND id = ?`,
        [context.organizationId, PILOT_RECORDS.propertyId],
      ),
      all(
        `SELECT id, property_id, name, version FROM property_zones
         WHERE organization_id = ? AND property_id = ? ORDER BY name`,
        [context.organizationId, PILOT_RECORDS.propertyId],
      ),
      first(
        `SELECT id, property_id, source, description, issue_category,
                confidence, serviceability, status, triage_json, received_at,
                version
         FROM service_requests WHERE organization_id = ? AND id = ?`,
        [context.organizationId, PILOT_RECORDS.serviceRequestId],
      ),
      first(
        `SELECT id, service_request_id, property_id, playbook_version_id,
                technician_id, status, kind, parent_job_id, price_cents,
                actual_drive_minutes, actual_material_cost_cents,
                checked_in_at, completed_at, version
         FROM jobs WHERE organization_id = ? AND id = ?`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      first(
        `SELECT id, job_id, technician_id, starts_at, duration_minutes,
                status, version
         FROM appointments
         WHERE organization_id = ? AND job_id = ? AND status = 'CONFIRMED'
         ORDER BY starts_at DESC LIMIT 1`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      first(
        `SELECT id, service_type, version_label, status, effective_at,
                steps_json, required_evidence_json, aftercare_json, version
         FROM playbook_versions WHERE organization_id = ? AND id = ?`,
        [context.organizationId, PILOT_RECORDS.playbookVersionId],
      ),
      all(
        `SELECT sc.id, sc.technician_id, t.display_name AS technician,
                sc.starts_at, sc.expected_contribution, sc.score,
                sc.explanation_json, sc.approved_at, sc.version
         FROM schedule_candidates sc
         JOIN technicians t
           ON t.organization_id = sc.organization_id
          AND t.id = sc.technician_id
         WHERE sc.organization_id = ? AND sc.service_request_id = ?
         ORDER BY sc.score DESC`,
        [context.organizationId, PILOT_RECORDS.serviceRequestId],
      ),
      all(
        `SELECT id, category, note, unresolved, zone_id, technician_id,
                created_at, version
         FROM observations WHERE organization_id = ? AND job_id = ?
         ORDER BY created_at`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      all(
        `SELECT id, phase, revenue_cents, labor_minutes, labor_cost_cents,
                drive_minutes, drive_cost_cents, material_cost_cents,
                expected_reservice_cost_cents, actual_reservice_cost_cents,
                contribution_margin_cents, source_json, updated_at, version
         FROM margin_snapshots WHERE organization_id = ? AND job_id = ?
         ORDER BY created_at`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      first(
        `SELECT id, status, technician_assessment,
                observation_window_ends_at, verified_at,
                verified_by_user_id, verification_source, verification_note,
                recurrence_risk_score, explanation_json, version
         FROM service_outcomes WHERE organization_id = ? AND job_id = ?`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      all(
        `SELECT id, due_at, status, result, source, note,
                verified_by_user_id, completed_at, version
         FROM outcome_checkpoints WHERE organization_id = ? AND job_id = ?
         ORDER BY due_at`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      all(
        `SELECT id, due_at, reason, status, owner_user_id, resolution_note,
                resolved_at, version
         FROM follow_ups WHERE organization_id = ? AND job_id = ?
         ORDER BY due_at`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      first(
        `SELECT id, revision, sha256, generated_at, generated_by_user_id,
                status, version
         FROM service_proofs WHERE organization_id = ? AND job_id = ?
         ORDER BY revision DESC LIMIT 1`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      all(
        `SELECT id, report_id, channel, recipient, status,
                provider_message_id, failure_reason, queued_at, delivered_at,
                version
         FROM proof_deliveries WHERE organization_id = ? AND job_id = ?
         ORDER BY queued_at DESC`,
        [context.organizationId, PILOT_RECORDS.jobId],
      ),
      first(
        `SELECT id, provider, mode, status, capabilities_json,
                last_successful_sync_at, version
         FROM integration_connections
         WHERE organization_id = ? AND id = ?`,
        [context.organizationId, PILOT_RECORDS.integrationConnectionId],
      ),
      all(
        `SELECT id, direction, status, cursor, imported_count,
                exported_count, source_count, reconciled_count, attempt,
                started_at, finished_at, error_summary, version
         FROM integration_syncs
         WHERE organization_id = ? AND connection_id = ?
         ORDER BY started_at DESC LIMIT 10`,
        [context.organizationId, PILOT_RECORDS.integrationConnectionId],
      ),
    ]);

    const canReadCustomers = context.permissions.includes("CUSTOMER_READ");
    const canReadEconomics = context.permissions.includes("ECONOMICS_READ");
    const canApproveSchedule =
      context.permissions.includes("SCHEDULE_APPROVE");
    const canSendProof = context.permissions.includes("PROOF_SEND");
    const canManageIntegrations =
      context.permissions.includes("INTEGRATION_MANAGE");

    return Response.json({
      data: {
        identity: {
          userId: context.actorId,
          email: context.actorEmail,
          displayName: context.actorDisplayName,
          role: context.role,
          technicianId: context.technicianId,
          permissions: context.permissions,
        },
        organization,
        branch,
        customer: canReadCustomers ? customer : null,
        property,
        zones,
        serviceRequest,
        job: jobDetail,
        appointment,
        playbook,
        scheduleCandidates: canApproveSchedule ? candidates : [],
        observations,
        economics: canReadEconomics ? margins : [],
        outcome,
        outcomeCheckpoints: checkpoints,
        followUps,
        serviceProof: proof,
        proofDeliveries: canSendProof ? deliveries : [],
        integration: {
          connection: canManageIntegrations ? connection : null,
          syncs: canManageIntegrations ? syncs : [],
        },
      },
      correlationId,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "OPERATIONS_UNAVAILABLE",
          message: "The operating record could not be loaded.",
          correlationId,
        },
      },
      { status: 503 },
    );
  }
}

async function first(sql: string, values: unknown[]) {
  return env.DB.prepare(sql).bind(...values).first();
}

async function all(sql: string, values: unknown[]) {
  const result = await env.DB.prepare(sql).bind(...values).all();
  return result.results;
}
