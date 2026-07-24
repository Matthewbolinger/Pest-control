import { env } from "cloudflare:workers";
import {
  applyWorkflowCommand,
  createInitialWorkflowSnapshot,
  FIELDPROOF_DEMO,
  WorkflowCommandSchema,
  WorkflowSnapshotSchema,
  WorkflowTransitionError,
  type WorkflowCommand,
  type WorkflowSnapshot,
} from "@/packages/application/workflow";
import {
  AutonomyLevelSchema,
  evaluateActionPolicy,
} from "@/packages/domain";
import type { Permission } from "@/packages/domain/authorization";
import { MockAIProvider } from "@/packages/ai";
import {
  authorizePermission,
  contextDenied,
  getRequestContext,
  isCrossSiteMutation,
  type RequestContext,
} from "@/app/api/v1/request-context";

type SnapshotRow = {
  id?: string;
  snapshot_json: string;
  version: number;
};

type ReceiptRow = {
  request_json: string;
  response_json: string;
};

type TriageInputRow = {
  description: string;
  property_type: string;
  address: string;
  territory: string;
  recurring_plan_status: string;
};

type ProofProjection = {
  canonicalJson: string;
  sha256: string;
};

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  try {
    const resolution = await getRequestContext(request, env.DB);
    if (!resolution.context) return contextDenied(resolution, correlationId);
    const context = resolution.context;
    const snapshot = await loadOrCreateSnapshot(context);
    const denied = authorizeWorkflowRead(context, snapshot, correlationId);
    if (denied) return denied;
    return Response.json({ data: snapshot, correlationId });
  } catch (error) {
    return serverError(correlationId, error);
  }
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  let context: RequestContext;
  try {
    const resolution = await getRequestContext(request, env.DB);
    if (!resolution.context) return contextDenied(resolution, correlationId);
    context = resolution.context;
  } catch (error) {
    return serverError(correlationId, error);
  }
  if (isCrossSiteMutation(request)) {
    return Response.json(
      {
        error: {
          code: "CROSS_SITE_WRITE_REJECTED",
          message: "Cross-site workflow changes are not allowed.",
          correlationId,
        },
      },
      { status: 403 },
    );
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim() !==
    "application/json"
  ) {
    return Response.json(
      {
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Workflow commands require application/json.",
          correlationId,
        },
      },
      { status: 415 },
    );
  }

  const parsed = WorkflowCommandSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "The workflow command was not valid.",
          correlationId,
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }

  const command = parsed.data;
  if (request.headers.get("idempotency-key") !== command.commandId) {
    return Response.json(
      {
        error: {
          code: "IDEMPOTENCY_KEY_MISMATCH",
          message:
            "Idempotency-Key must match the commandId in the request body.",
          correlationId,
        },
      },
      { status: 400 },
    );
  }
  const requestJson = JSON.stringify(command);

  try {
    const priorReceipt = await findReceipt(
      context.organizationId,
      command.commandId,
    );
    if (priorReceipt) {
      if (priorReceipt.request_json !== requestJson) {
        return conflict(
          correlationId,
          "IDEMPOTENCY_KEY_REUSED",
          "That commandId was already used for a different command.",
        );
      }
      return Response.json({
        data: await loadOrCreateSnapshot(context),
        correlationId,
        idempotent: true,
      });
    }

    const current = await loadOrCreateSnapshot(context);
    if (current.version !== command.expectedVersion) {
      return versionConflict(correlationId, current);
    }
    const denied = authorizeWorkflowCommand(
      context,
      current,
      command,
      correlationId,
    );
    if (denied) return denied;
    const policyDenied = evaluateCommandPolicy(
      context,
      current,
      command,
      correlationId,
    );
    if (policyDenied) return policyDenied;
    const relationshipDenied = await validateCommandRelationships(
      context,
      current,
      command,
      correlationId,
    );
    if (relationshipDenied) return relationshipDenied;

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let next: WorkflowSnapshot;
    try {
      const triageProposal =
        command.type === "RUN_TRIAGE"
          ? await generateTriage(context.organizationId)
          : undefined;
      next = applyWorkflowCommand(current, command, nowIso, {
        triageProposal,
        actorId: context.actorId,
        verifierId:
          command.type === "VERIFY_OUTCOME" ? context.actorId : undefined,
        verifiedAt:
          command.type === "VERIFY_OUTCOME"
            ? new Date(
                Math.max(
                  now,
                  new Date(current.completedAt ?? nowIso).getTime() + 1,
                ),
              ).toISOString()
            : undefined,
        verificationWindowDays: 7,
      });
    } catch (error) {
      if (error instanceof WorkflowTransitionError) {
        return conflict(correlationId, error.code, error.message);
      }
      throw error;
    }

    let proofProjection: ProofProjection | null = null;
    if (command.type === "COMPLETE_JOB") {
      proofProjection = await createProofProjection(next, context);
      next = WorkflowSnapshotSchema.parse({
        ...next,
        proofSha256: proofProjection.sha256,
      });
    }

    const event = eventFor(command);
    const responseJson = JSON.stringify(next);
    const receiptId = `WCR-${crypto.randomUUID()}`;
    const auditId = `AUD-${crypto.randomUUID()}`;
    const outboxId = `OUT-${crypto.randomUUID()}`;
    const outboxKey = `${context.organizationId}:${current.workflowId}:${command.commandId}`;
    const storageId = workflowStorageId(
      context.organizationId,
      current.workflowId,
    );

    const statements = [
      env.DB.prepare(
        `UPDATE workflow_snapshots
         SET assigned_technician_id = ?, snapshot_json = ?, last_command_id = ?,
             updated_at = ?, version = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND (last_command_id IS NULL OR last_command_id <> ?)`,
      ).bind(
        next.assignedTechnicianId,
        responseJson,
        command.commandId,
        now,
        next.version,
        storageId,
        context.organizationId,
        current.version,
        command.commandId,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO workflow_command_receipts
          (id, organization_id, workflow_id, command_id, command_type,
           request_json, response_json, applied_version, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM workflow_snapshots
           WHERE id = ? AND organization_id = ? AND version = ?
             AND last_command_id = ?
         )`,
      ).bind(
        receiptId,
        context.organizationId,
        current.workflowId,
        command.commandId,
        command.type,
        requestJson,
        responseJson,
        next.version,
        now,
        storageId,
        context.organizationId,
        next.version,
        command.commandId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, organization_id, actor_type, actor_id, action, entity_type,
           entity_id, occurred_at, correlation_id, reason, model_version,
           policy_version, previous_json, next_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM workflow_command_receipts
           WHERE id = ? AND organization_id = ?
         )`,
      ).bind(
        auditId,
        context.organizationId,
        context.actorType,
        context.actorId,
        event.action,
        event.entityType,
        event.entityId,
        now,
        correlationId,
        event.reason,
        command.type === "RUN_TRIAGE" ? "mock-ai-v1" : null,
        "fieldproof-assurance-v1",
        JSON.stringify(current),
        responseJson,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO outbox_events
          (id, organization_id, event_type, entity_id, payload_json,
           idempotency_key, status, attempts, available_at, last_error,
           processed_at, created_at, updated_at, version)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1
         WHERE EXISTS (
           SELECT 1 FROM workflow_command_receipts
           WHERE id = ? AND organization_id = ?
         )`,
      ).bind(
        outboxId,
        context.organizationId,
        event.action,
        event.entityId,
        JSON.stringify({
          workflowId: current.workflowId,
          commandId: command.commandId,
          commandType: command.type,
          version: next.version,
        }),
        outboxKey,
        command.type === "SEND_PROOF" ? "PENDING" : "PROCESSED",
        command.type === "SEND_PROOF" ? 0 : 1,
        now,
        command.type === "SEND_PROOF" ? null : now,
        now,
        now,
        receiptId,
        context.organizationId,
      ),
      ...projectionStatements({
        command,
        current,
        next,
        context,
        now,
        receiptId,
        proofProjection,
      }),
      projectionAssertionStatement({
        command,
        current,
        next,
        context,
        now,
        receiptId,
        auditId,
        outboxId,
        proofProjection,
      }),
    ];

    const results = await env.DB.batch(statements);
    const updated = Number(results[0]?.meta?.changes ?? 0);
    if (updated !== 1) {
      const racedReceipt = await findReceipt(
        context.organizationId,
        command.commandId,
      );
      if (racedReceipt?.request_json === requestJson) {
        return Response.json({
          data: await loadOrCreateSnapshot(context),
          correlationId,
          idempotent: true,
        });
      }
      return versionConflict(
        correlationId,
        await loadOrCreateSnapshot(context),
      );
    }

    return Response.json({
      data: next,
      correlationId,
      idempotent: false,
    });
  } catch (error) {
    return serverError(correlationId, error);
  }
}

async function loadOrCreateSnapshot(
  context: RequestContext,
  reconciliationAttempt = 0,
) {
  const now = Date.now();
  const initial = createInitialWorkflowSnapshot(new Date(now).toISOString());
  const storageId = workflowStorageId(
    context.organizationId,
    initial.workflowId,
  );
  const existing = await env.DB.prepare(
    `SELECT id, snapshot_json, version FROM workflow_snapshots
     WHERE organization_id = ? AND job_id = ? LIMIT 1`,
  )
    .bind(context.organizationId, initial.jobId)
    .first<SnapshotRow>();
  if (existing?.id && existing.id !== storageId) {
    await env.DB.prepare(
      `UPDATE workflow_snapshots SET id = ?
       WHERE id = ? AND organization_id = ?`,
    )
      .bind(storageId, existing.id, context.organizationId)
      .run();
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_snapshots
      (id, organization_id, service_request_id, job_id, property_id,
       assigned_technician_id, snapshot_json, last_command_id, created_at,
       updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      storageId,
      context.organizationId,
      initial.serviceRequestId,
      initial.jobId,
      initial.propertyId,
      initial.assignedTechnicianId,
      JSON.stringify(initial),
      initial.lastCommandId,
      now,
      now,
      initial.version,
    )
    .run();

  const row = await env.DB.prepare(
    `SELECT id, snapshot_json, version FROM workflow_snapshots
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(storageId, context.organizationId)
    .first<SnapshotRow>();
  if (!row) throw new Error("Workflow snapshot was not available.");

  const snapshot = WorkflowSnapshotSchema.parse(JSON.parse(row.snapshot_json));
  if (snapshot.version !== row.version) {
    throw new Error("Workflow snapshot version is inconsistent.");
  }
  if (
    snapshot.proofId &&
    (!snapshot.proofSent ||
      snapshot.proofDeliveryStatus !== "DELIVERED")
  ) {
    const delivered = await env.DB.prepare(
      `SELECT id, delivered_at
       FROM proof_deliveries
       WHERE organization_id = ? AND job_id = ? AND report_id = ?
         AND status = 'DELIVERED' AND delivered_at IS NOT NULL
       ORDER BY delivered_at DESC LIMIT 1`,
    )
      .bind(context.organizationId, snapshot.jobId, snapshot.proofId)
      .first<{ id: string; delivered_at: number }>();
    if (delivered) {
      const reconciledAt = Math.max(
        delivered.delivered_at,
        new Date(snapshot.updatedAt).getTime(),
      );
      const reconciled = WorkflowSnapshotSchema.parse({
        ...snapshot,
        version: snapshot.version + 1,
        lastCommandId: `DELIVERY:RECONCILE:${delivered.id}`,
        proofDeliveryStatus: "DELIVERED",
        proofSent: true,
        updatedAt: new Date(reconciledAt).toISOString(),
      });
      const update = await env.DB.prepare(
        `UPDATE workflow_snapshots
         SET snapshot_json = ?, last_command_id = ?, updated_at = ?,
             version = ?
         WHERE id = ? AND organization_id = ? AND version = ?`,
      )
        .bind(
          JSON.stringify(reconciled),
          reconciled.lastCommandId,
          reconciledAt,
          reconciled.version,
          row.id,
          context.organizationId,
          snapshot.version,
        )
        .run();
      if (Number(update.meta?.changes ?? 0) === 1) return reconciled;
      if (reconciliationAttempt < 11) {
        return loadOrCreateSnapshot(context, reconciliationAttempt + 1);
      }
      throw new Error(
        "The delivered proof snapshot did not converge before it was read.",
      );
    }
  }
  return snapshot;
}

async function findReceipt(organizationId: string, commandId: string) {
  return env.DB.prepare(
    `SELECT request_json, response_json
     FROM workflow_command_receipts
     WHERE organization_id = ? AND command_id = ?`,
  )
    .bind(organizationId, commandId)
    .first<ReceiptRow>();
}

async function generateTriage(organizationId: string) {
  const input = await env.DB.prepare(
    `SELECT sr.description, p.property_type, p.address, b.territory,
            p.recurring_plan_status
     FROM service_requests sr
     JOIN properties p
       ON p.organization_id = sr.organization_id
      AND p.id = sr.property_id
     JOIN branches b
       ON b.organization_id = p.organization_id
      AND b.id = p.branch_id
     WHERE sr.organization_id = ? AND sr.id = ?`,
  )
    .bind(organizationId, FIELDPROOF_DEMO.serviceRequestId)
    .first<TriageInputRow>();
  if (!input) throw new Error("Triage input was not found.");
  return new MockAIProvider().triageServiceRequest({
    description: input.description,
    propertyFacts: [
      `${input.property_type.replaceAll("_", " ")} property.`,
      `${input.territory} service territory.`,
      `${input.recurring_plan_status} recurring service plan.`,
      `Property record: ${input.address}.`,
      "Existing Basement property zone.",
    ],
  });
}

function authorizeWorkflowRead(
  context: RequestContext,
  snapshot: WorkflowSnapshot,
  correlationId: string,
) {
  const officeDenied = authorizePermission(
    context,
    "JOB_READ_ALL",
    correlationId,
  );
  if (!officeDenied) return null;
  return authorizePermission(
    context,
    "JOB_READ_ASSIGNED",
    correlationId,
    snapshot.assignedTechnicianId,
  );
}

function authorizeWorkflowCommand(
  context: RequestContext,
  snapshot: WorkflowSnapshot,
  command: WorkflowCommand,
  correlationId: string,
) {
  const permission = permissionForCommand(command);
  const assigned = isAssignedFieldCommand(command)
    ? snapshot.assignedTechnicianId
    : undefined;
  return authorizePermission(context, permission, correlationId, assigned);
}

function permissionForCommand(command: WorkflowCommand): Permission {
  switch (command.type) {
    case "RUN_TRIAGE":
      return "SERVICE_REQUEST_WRITE";
    case "APPROVE_TRIAGE":
      return "TRIAGE_APPROVE";
    case "APPROVE_SCHEDULE":
      return "SCHEDULE_APPROVE";
    case "CHECK_IN":
    case "SET_CHECKLIST_STEP":
    case "ADD_OBSERVATION":
    case "REVIEW_RISK":
      return "JOB_FIELD_WRITE_ASSIGNED";
    case "COMPLETE_JOB":
      return "JOB_COMPLETE_ASSIGNED";
    case "SEND_PROOF":
      return "PROOF_SEND";
    case "VERIFY_OUTCOME":
      return "OUTCOME_VERIFY";
    case "RECORD_RESERVICE":
      return "RESERVICE_CREATE";
    case "RESOLVE_EXCEPTION":
      return "EXCEPTION_MANAGE";
    case "RESET_DEMO":
      return "ORGANIZATION_MANAGE";
  }
}

function isAssignedFieldCommand(command: WorkflowCommand) {
  return (
    command.type === "CHECK_IN" ||
    command.type === "SET_CHECKLIST_STEP" ||
    command.type === "ADD_OBSERVATION" ||
    command.type === "REVIEW_RISK" ||
    command.type === "COMPLETE_JOB"
  );
}

async function validateCommandRelationships(
  context: RequestContext,
  current: WorkflowSnapshot,
  command: WorkflowCommand,
  correlationId: string,
) {
  if (command.type === "COMPLETE_JOB") {
    const appointment = await env.DB.prepare(
      `SELECT id
       FROM appointments
       WHERE organization_id = ? AND job_id = ? AND technician_id = ?
         AND status = 'CONFIRMED'
       LIMIT 1`,
    )
      .bind(
        context.organizationId,
        current.jobId,
        current.assignedTechnicianId,
      )
      .first<{ id: string }>();
    if (!appointment) {
      return conflict(
        correlationId,
        "CONFIRMED_APPOINTMENT_REQUIRED",
        "Field completion requires the persisted confirmed appointment for the assigned technician.",
      );
    }
  }

  if (command.type === "RECORD_RESERVICE") {
    if (command.reserviceJobId === current.jobId) {
      return conflict(
        correlationId,
        "INVALID_RESERVICE_RELATIONSHIP",
        "A job cannot be linked as its own reservice.",
      );
    }
    const existing = await env.DB.prepare(
      `SELECT id FROM jobs WHERE id = ? LIMIT 1`,
    )
      .bind(command.reserviceJobId)
      .first<{ id: string }>();
    if (existing) {
      return conflict(
        correlationId,
        "RESERVICE_JOB_ID_EXISTS",
        "That reservice job identifier is already in use.",
      );
    }
  }

  if (command.type === "RESOLVE_EXCEPTION") {
    const owner = await env.DB.prepare(
      `SELECT m.user_id
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND m.user_id = ?
         AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
       LIMIT 1`,
    )
      .bind(context.organizationId, command.ownerUserId)
      .first<{ user_id: string }>();
    if (!owner) {
      return conflict(
        correlationId,
        "INVALID_EXCEPTION_OWNER",
        "The exception owner must be an active member of this organization.",
      );
    }
  }

  return null;
}

function evaluateCommandPolicy(
  context: RequestContext,
  current: WorkflowSnapshot,
  command: WorkflowCommand,
  correlationId: string,
) {
  if (
    command.type === "VERIFY_OUTCOME" &&
    command.source === "CUSTOMER_CONFIRMATION"
  ) {
    return Response.json(
      {
        error: {
          code: "TRUSTED_SOURCE_REQUIRED",
          message:
            "Direct customer confirmation must arrive through a verified customer or communications-provider event. Use the staff-recorded source for an authorized human attestation.",
          correlationId,
        },
      },
      { status: 422 },
    );
  }
  const actionType =
    command.type === "RUN_TRIAGE"
      ? "TRIAGE_REQUEST"
      : command.type === "APPROVE_SCHEDULE"
        ? "APPROVE_APPOINTMENT"
        : command.type === "COMPLETE_JOB"
          ? "GENERATE_REPORT"
          : null;
  if (!actionType) return null;

  const evaluatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const isWrite = actionType !== "TRIAGE_REQUEST";
  const decision = evaluateActionPolicy({
    actionType,
    autonomyLevel: AutonomyLevelSchema.parse(context.autonomyLevel),
    confidence:
      command.type === "RUN_TRIAGE"
        ? Math.max(current.triageProposal?.confidence ?? 0.95, 0.65)
        : 1,
    expiresAt,
    tenantMatch: true,
    evaluatedAt,
    approval: isWrite
      ? {
          id: `APR-${command.commandId}`,
          actionType,
          actorId: context.actorId,
          tenantMatch: true,
          grantedAt: evaluatedAt,
          expiresAt,
        }
      : undefined,
  });
  if (decision.allowed) return null;
  return Response.json(
    {
      error: {
        code: decision.code,
        message: decision.reason,
        correlationId,
      },
    },
    { status: 403 },
  );
}

function eventFor(command: WorkflowCommand) {
  const common = {
    entityType: "JOB",
    entityId: FIELDPROOF_DEMO.jobId,
  };
  switch (command.type) {
    case "RUN_TRIAGE":
      return {
        ...common,
        entityType: "SERVICE_REQUEST",
        entityId: FIELDPROOF_DEMO.serviceRequestId,
        action: "TRIAGE_PROPOSED",
        reason: "Structured triage was generated from persisted request facts.",
      };
    case "APPROVE_TRIAGE":
      return {
        ...common,
        entityType: "SERVICE_REQUEST",
        entityId: FIELDPROOF_DEMO.serviceRequestId,
        action: "TRIAGE_APPROVED",
        reason: "The authenticated operator approved the triage proposal.",
      };
    case "APPROVE_SCHEDULE":
      return {
        ...common,
        action: "APPOINTMENT_APPROVED",
        reason: `The authenticated operator approved candidate ${command.candidateId}.`,
      };
    case "CHECK_IN":
      return {
        ...common,
        action: "TECHNICIAN_CHECKED_IN",
        reason: "The assigned technician checked in to the field job.",
      };
    case "SET_CHECKLIST_STEP":
      return {
        ...common,
        action: "CHECKLIST_STEP_UPDATED",
        reason: `Required checklist step ${command.index + 1} was marked ${command.complete ? "complete" : "incomplete"}.`,
      };
    case "ADD_OBSERVATION":
      return {
        ...common,
        action: "OBSERVATION_RECORDED",
        reason: `A ${command.category.toLowerCase()} observation was recorded.`,
      };
    case "REVIEW_RISK":
      return {
        ...common,
        action: "RISK_REVIEWED",
        reason: command.unresolved
          ? "The technician identified an unresolved property risk."
          : "The technician explicitly recorded that no unresolved risk remains.",
      };
    case "COMPLETE_JOB":
      return {
        ...common,
        action: "FIELD_WORK_COMPLETED",
        reason:
          "The server completion gate validated typed evidence and created a pending outcome checkpoint.",
      };
    case "SEND_PROOF":
      return {
        ...common,
        entityType: "REPORT",
        entityId: `SP-${FIELDPROOF_DEMO.jobId}`,
        action: "SERVICE_PROOF_DELIVERY_QUEUED",
        reason: `Service Proof delivery was queued for ${command.channel.toLowerCase()}; it is not yet marked delivered.`,
      };
    case "VERIFY_OUTCOME":
      return {
        ...common,
        action: "OUTCOME_VERIFIED",
        reason: `An authorized actor distinct from the field completer recorded ${command.result} from ${command.source}.`,
      };
    case "RECORD_RESERVICE":
      return {
        ...common,
        action: "RESERVICE_LINKED",
        reason: `Reservice ${command.reserviceJobId} was linked with direct cost provenance.`,
      };
    case "RESOLVE_EXCEPTION":
      return {
        ...common,
        action: "EXCEPTION_RESOLVED",
        reason: `The exception was assigned to ${command.ownerUserId} and resolved with a note.`,
      };
    case "RESET_DEMO":
      return {
        ...common,
        action: "DEMO_WORKFLOW_RESET",
        reason:
          "The authenticated owner cleared repeatable demo projections; audit, command receipts, evidence assets, and integration history were retained.",
      };
  }
}

function projectionStatements(input: {
  command: WorkflowCommand;
  current: WorkflowSnapshot;
  next: WorkflowSnapshot;
  context: RequestContext;
  now: number;
  receiptId: string;
  proofProjection: ProofProjection | null;
}) {
  const { command, current, next, context, now, receiptId, proofProjection } =
    input;
  const gate = `EXISTS (
    SELECT 1 FROM workflow_command_receipts
    WHERE id = ? AND organization_id = ?
  )`;
  const statements: D1PreparedStatement[] = [];

  if (command.type === "RUN_TRIAGE") {
    statements.push(
      env.DB.prepare(
        `UPDATE service_requests
         SET issue_category = ?, confidence = ?, serviceability = ?,
             status = 'NEEDS_REVIEW', triage_json = ?, updated_at = ?,
             version = version + 1
         WHERE organization_id = ? AND id = ? AND ${gate}`,
      ).bind(
        next.triageProposal?.issueCategory ?? null,
        next.triageProposal?.confidence ?? null,
        next.triageProposal?.serviceable ? "SERVICEABLE" : "DECLINED",
        JSON.stringify(next.triageProposal),
        now,
        context.organizationId,
        current.serviceRequestId,
        receiptId,
        context.organizationId,
      ),
    );
  }

  if (command.type === "APPROVE_TRIAGE") {
    statements.push(
      env.DB.prepare(
        `UPDATE service_requests
         SET status = 'READY_TO_SCHEDULE', updated_at = ?,
             version = version + 1
         WHERE organization_id = ? AND id = ? AND ${gate}`,
      ).bind(
        now,
        context.organizationId,
        current.serviceRequestId,
        receiptId,
        context.organizationId,
      ),
    );
  }

  if (command.type === "APPROVE_SCHEDULE" && next.expectedEconomics) {
    const economics = next.expectedEconomics;
    statements.push(
      env.DB.prepare(
        `INSERT INTO appointments
          (id, organization_id, job_id, technician_id, starts_at,
           duration_minutes, status, idempotency_key, created_at, updated_at,
           version)
         SELECT ?, ?, ?, sc.technician_id, sc.starts_at, 90, 'CONFIRMED', ?,
                ?, ?, 1
         FROM schedule_candidates sc
         WHERE sc.organization_id = ? AND sc.id = ? AND ${gate}
         ON CONFLICT(id) DO UPDATE SET
           technician_id = excluded.technician_id,
           starts_at = excluded.starts_at,
           status = 'CONFIRMED',
           updated_at = excluded.updated_at,
           version = appointments.version + 1`,
      ).bind(
        `APPT-${current.jobId}`,
        context.organizationId,
        current.jobId,
        command.commandId,
        now,
        now,
        context.organizationId,
        command.candidateId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE schedule_candidates
         SET approved_at = ?, updated_at = ?, version = version + 1
         WHERE organization_id = ? AND id = ? AND ${gate}`,
      ).bind(
        now,
        now,
        context.organizationId,
        command.candidateId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE jobs
         SET technician_id = ?, status = 'SCHEDULED', updated_at = ?,
             version = version + 1
         WHERE organization_id = ? AND id = ? AND ${gate}`,
      ).bind(
        next.assignedTechnicianId,
        now,
        context.organizationId,
        current.jobId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE service_requests
         SET status = 'SCHEDULED', updated_at = ?, version = version + 1
         WHERE organization_id = ? AND id = ? AND ${gate}`,
      ).bind(
        now,
        context.organizationId,
        current.serviceRequestId,
        receiptId,
        context.organizationId,
      ),
      marginStatement(
        context,
        current.jobId,
        economics,
        now,
        receiptId,
      ),
    );
  }

  if (command.type === "CHECK_IN") {
    statements.push(
      env.DB.prepare(
        `UPDATE jobs
         SET status = 'IN_PROGRESS', checked_in_at = ?, updated_at = ?,
             version = version + 1
         WHERE organization_id = ? AND id = ? AND technician_id = ?
           AND ${gate}`,
      ).bind(
        now,
        now,
        context.organizationId,
        current.jobId,
        current.assignedTechnicianId,
        receiptId,
        context.organizationId,
      ),
    );
  }

  if (command.type === "ADD_OBSERVATION") {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO observations
          (id, organization_id, job_id, property_id, zone_id, technician_id,
           category, note, unresolved, created_at, updated_at, version)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1 WHERE ${gate}`,
      ).bind(
        `OBS-${crypto.randomUUID()}`,
        context.organizationId,
        current.jobId,
        current.propertyId,
        FIELDPROOF_DEMO.zoneIds[0],
        current.assignedTechnicianId,
        command.category,
        command.note,
        now,
        now,
        receiptId,
        context.organizationId,
      ),
    );
  }

  if (
    command.type === "COMPLETE_JOB" &&
    next.actualEconomics &&
    proofProjection
  ) {
    statements.push(
      env.DB.prepare(
        `UPDATE jobs
         SET status = 'FIELD_WORK_COMPLETE', completed_at = ?,
             actual_drive_minutes = ?, actual_material_cost_cents = ?,
             updated_at = ?, version = version + 1
         WHERE organization_id = ? AND id = ? AND technician_id = ?
           AND ${gate}`,
      ).bind(
        now,
        command.actualDriveMinutes,
        command.actualMaterialCostCents,
        now,
        context.organizationId,
        current.jobId,
        current.assignedTechnicianId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `INSERT INTO service_outcomes
          (id, organization_id, job_id, status, recurrence_risk_score,
           explanation_json, technician_assessment,
           observation_window_ends_at, verified_at, verified_by_user_id,
           verification_source, verification_note, created_at, updated_at,
           version)
         SELECT ?, ?, ?, 'PENDING_VERIFICATION', ?, ?, ?, ?, NULL, NULL,
                NULL, NULL, ?, ?, 1 WHERE ${gate}
         ON CONFLICT(id) DO UPDATE SET
           status = 'PENDING_VERIFICATION',
           recurrence_risk_score = excluded.recurrence_risk_score,
           explanation_json = excluded.explanation_json,
           technician_assessment = excluded.technician_assessment,
           observation_window_ends_at = excluded.observation_window_ends_at,
           verified_at = NULL,
           verified_by_user_id = NULL,
           verification_source = NULL,
           verification_note = NULL,
           updated_at = excluded.updated_at,
           version = service_outcomes.version + 1`,
      ).bind(
        `OUTCOME-${current.jobId}`,
        context.organizationId,
        current.jobId,
        next.riskScore,
        JSON.stringify({
          source: "completion-assurance-v1",
          riskReview: next.riskReview,
          evidencePolicyVersion: next.evidencePolicyVersion,
          resolutionClaimed: false,
        }),
        next.technicianAssessment,
        new Date(next.verificationWindowEndsAt ?? now).getTime(),
        now,
        now,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `INSERT INTO outcome_checkpoints
          (id, organization_id, job_id, property_id, due_at, status, result,
           source, note, verified_by_user_id, completed_at, idempotency_key,
           created_at, updated_at, version)
         SELECT ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL, NULL, ?,
                ?, ?, 1 WHERE ${gate}
         ON CONFLICT(id) DO UPDATE SET
           due_at = excluded.due_at,
           status = 'PENDING',
           result = NULL,
           source = NULL,
           note = NULL,
           verified_by_user_id = NULL,
           completed_at = NULL,
           updated_at = excluded.updated_at,
           version = outcome_checkpoints.version + 1`,
      ).bind(
        `CHK-${current.jobId}-7D`,
        context.organizationId,
        current.jobId,
        current.propertyId,
        new Date(next.verificationWindowEndsAt ?? now).getTime(),
        `${context.organizationId}:${current.jobId}:7D`,
        now,
        now,
        receiptId,
        context.organizationId,
      ),
      marginStatement(
        context,
        current.jobId,
        next.actualEconomics,
        now,
        receiptId,
      ),
      env.DB.prepare(
        `INSERT INTO service_proofs
          (id, organization_id, job_id, revision, canonical_json, sha256,
           generated_at, generated_by_user_id, status, created_at, updated_at,
           version)
         SELECT ?, ?, ?, 1, ?, ?, ?, ?, 'GENERATED', ?, ?, 1 WHERE ${gate}
         ON CONFLICT(id) DO UPDATE SET
           canonical_json = excluded.canonical_json,
           sha256 = excluded.sha256,
           generated_at = excluded.generated_at,
           generated_by_user_id = excluded.generated_by_user_id,
           status = 'GENERATED',
           updated_at = excluded.updated_at,
           version = service_proofs.version + 1`,
      ).bind(
        next.proofId,
        context.organizationId,
        current.jobId,
        proofProjection.canonicalJson,
        proofProjection.sha256,
        now,
        context.actorId,
        now,
        now,
        receiptId,
        context.organizationId,
      ),
    );
    if (next.followUpCreated) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO follow_ups
            (id, organization_id, job_id, property_id, due_at, reason, status,
             owner_user_id, resolution_note, resolved_at, created_at,
             updated_at, version)
           SELECT ?, ?, ?, ?, ?, ?, 'OPEN', NULL, NULL, NULL, ?, ?, 1
           WHERE ${gate}
           ON CONFLICT(id) DO UPDATE SET
             due_at = excluded.due_at,
             reason = excluded.reason,
             status = 'OPEN',
             owner_user_id = NULL,
             resolution_note = NULL,
             resolved_at = NULL,
             updated_at = excluded.updated_at,
             version = follow_ups.version + 1`,
        ).bind(
          `FOLLOWUP-${current.jobId}`,
          context.organizationId,
          current.jobId,
          current.propertyId,
          now + 24 * 60 * 60 * 1000,
          "Verify and address the unresolved north sill-plate entry point.",
          now,
          now,
          receiptId,
          context.organizationId,
        ),
        env.DB.prepare(
          `INSERT INTO exception_records
            (id, organization_id, job_id, type, severity, reason, confidence,
             financial_impact, status, owner_user_id, resolution_note,
             resolved_at, created_at, updated_at, version)
           SELECT ?, ?, ?, 'UNRESOLVED_PROPERTY_RISK', 'HIGH', ?, 1, ?, 'OPEN',
                  NULL, NULL, NULL, ?, ?, 1 WHERE ${gate}
           ON CONFLICT(id) DO UPDATE SET
             status = 'OPEN',
             owner_user_id = NULL,
             resolution_note = NULL,
             resolved_at = NULL,
             updated_at = excluded.updated_at,
             version = exception_records.version + 1`,
        ).bind(
          `EX-${current.jobId}`,
          context.organizationId,
          current.jobId,
          "The visit ended with an unresolved entry-point condition.",
          (next.expectedEconomics?.expectedReserviceCostCents ?? 0) / 100,
          now,
          now,
          receiptId,
          context.organizationId,
        ),
      );
    }
  }

  if (command.type === "SEND_PROOF" && next.proofId) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO proof_deliveries
          (id, organization_id, job_id, report_id, channel, recipient, status,
           provider_message_id, failure_reason, queued_at, delivered_at,
           idempotency_key, created_at, updated_at, version)
         SELECT ?, ?, ?, ?, ?, ?, 'QUEUED', NULL, NULL, ?, NULL, ?, ?, ?, 1
         WHERE ${gate}
         ON CONFLICT(organization_id, idempotency_key) DO NOTHING`,
      ).bind(
        `DEL-${crypto.randomUUID()}`,
        context.organizationId,
        current.jobId,
        next.proofId,
        command.channel,
        command.recipient,
        now,
        command.commandId,
        now,
        now,
        receiptId,
        context.organizationId,
      ),
    );
  }

  if (
    command.type === "VERIFY_OUTCOME" &&
    next.verification &&
    next.finalEconomics
  ) {
    statements.push(
      env.DB.prepare(
        `UPDATE service_outcomes
         SET status = ?, verified_at = ?, verified_by_user_id = ?,
             verification_source = ?, verification_note = ?, updated_at = ?,
             version = version + 1
         WHERE organization_id = ? AND job_id = ? AND ${gate}`,
      ).bind(
        next.outcome,
        new Date(next.verification.verifiedAt).getTime(),
        next.verification.verifiedById,
        next.verification.source,
        next.verification.note,
        now,
        context.organizationId,
        current.jobId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE outcome_checkpoints
         SET status = 'COMPLETED', result = ?, source = ?, note = ?,
             verified_by_user_id = ?, completed_at = ?, updated_at = ?,
             version = version + 1
         WHERE organization_id = ? AND job_id = ? AND status = 'PENDING'
           AND ${gate}`,
      ).bind(
        next.outcome,
        next.verification.source,
        next.verification.note,
        next.verification.verifiedById,
        new Date(next.verification.verifiedAt).getTime(),
        now,
        context.organizationId,
        current.jobId,
        receiptId,
        context.organizationId,
      ),
      marginStatement(
        context,
        current.jobId,
        next.finalEconomics,
        now,
        receiptId,
      ),
    );
  }

  if (command.type === "RECORD_RESERVICE" && next.finalEconomics) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO jobs
          (id, organization_id, service_request_id, property_id,
           playbook_version_id, technician_id, status, kind, parent_job_id,
           price_cents, actual_drive_minutes, actual_material_cost_cents,
           checked_in_at, completed_at, created_at, updated_at, version)
         SELECT ?, ?, ?, ?, ?, NULL, 'DRAFT', 'RESERVICE', ?, 0, NULL, NULL,
                NULL, NULL, ?, ?, 1 WHERE ${gate}`,
      ).bind(
        command.reserviceJobId,
        context.organizationId,
        current.serviceRequestId,
        current.propertyId,
        current.playbookVersionId,
        current.jobId,
        now,
        now,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `INSERT INTO reservice_events
          (id, organization_id, original_job_id, reservice_job_id, reason,
           cost_cents, occurred_at, created_at, updated_at, version)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1 WHERE ${gate}`,
      ).bind(
        `RS-${crypto.randomUUID()}`,
        context.organizationId,
        current.jobId,
        command.reserviceJobId,
        command.reason,
        command.directCostCents,
        now,
        now,
        now,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE service_outcomes
         SET status = 'RESERVICE_REQUIRED', updated_at = ?,
             version = version + 1
         WHERE organization_id = ? AND job_id = ? AND ${gate}`,
      ).bind(
        now,
        context.organizationId,
        current.jobId,
        receiptId,
        context.organizationId,
      ),
      marginStatement(
        context,
        current.jobId,
        next.finalEconomics,
        now,
        receiptId,
      ),
    );
  }

  if (command.type === "RESOLVE_EXCEPTION") {
    statements.push(
      env.DB.prepare(
        `UPDATE follow_ups
         SET status = 'RESOLVED', owner_user_id = ?, resolution_note = ?,
             resolved_at = ?, updated_at = ?, version = version + 1
         WHERE organization_id = ? AND job_id = ? AND ${gate}`,
      ).bind(
        command.ownerUserId,
        command.resolutionNote,
        now,
        now,
        context.organizationId,
        current.jobId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE exception_records
         SET status = 'RESOLVED', owner_user_id = ?, resolution_note = ?,
             resolved_at = ?, updated_at = ?, version = version + 1
         WHERE organization_id = ? AND job_id = ? AND ${gate}`,
      ).bind(
        command.ownerUserId,
        command.resolutionNote,
        now,
        now,
        context.organizationId,
        current.jobId,
        receiptId,
        context.organizationId,
      ),
    );
  }

  if (command.type === "RESET_DEMO") {
    statements.push(
      env.DB.prepare(
        `DELETE FROM outbox_events
         WHERE organization_id = ?
           AND event_type = 'SERVICE_PROOF_DELIVERY_QUEUED'
           AND json_extract(payload_json, '$.workflowId') = ?
           AND ${gate}`,
      ).bind(
        context.organizationId,
        current.workflowId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE jobs
         SET technician_id = NULL, status = 'DRAFT', actual_drive_minutes = NULL,
             actual_material_cost_cents = NULL, checked_in_at = NULL,
             completed_at = NULL, updated_at = ?, version = version + 1
         WHERE organization_id = ? AND id = ? AND ${gate}`,
      ).bind(
        now,
        context.organizationId,
        current.jobId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE service_requests
         SET issue_category = NULL, confidence = NULL, serviceability = NULL,
             status = 'NEW', triage_json = NULL, updated_at = ?,
             version = version + 1
         WHERE organization_id = ? AND id = ? AND ${gate}`,
      ).bind(
        now,
        context.organizationId,
        current.serviceRequestId,
        receiptId,
        context.organizationId,
      ),
      ...[
        "appointments",
        "observations",
        "service_outcomes",
        "outcome_checkpoints",
        "margin_snapshots",
        "follow_ups",
        "exception_records",
        "service_proofs",
        "proof_deliveries",
        "reservice_events",
      ].map((table) =>
        env.DB.prepare(
          `DELETE FROM ${table}
           WHERE organization_id = ? AND ${
             table === "reservice_events" ? "original_job_id" : "job_id"
           } = ? AND ${gate}`,
        ).bind(
          context.organizationId,
          current.jobId,
          receiptId,
          context.organizationId,
        ),
      ),
      env.DB.prepare(
        `DELETE FROM jobs
         WHERE organization_id = ? AND kind = 'RESERVICE'
           AND parent_job_id = ? AND ${gate}`,
      ).bind(
        context.organizationId,
        current.jobId,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `UPDATE schedule_candidates
         SET approved_at = NULL, updated_at = ?, version = version + 1
         WHERE organization_id = ? AND service_request_id = ? AND ${gate}`,
      ).bind(
        now,
        context.organizationId,
        current.serviceRequestId,
        receiptId,
        context.organizationId,
      ),
    );
  }

  return statements;
}

function projectionAssertionStatement(input: {
  command: WorkflowCommand;
  current: WorkflowSnapshot;
  next: WorkflowSnapshot;
  context: RequestContext;
  now: number;
  receiptId: string;
  auditId: string;
  outboxId: string;
  proofProjection: ProofProjection | null;
}) {
  const {
    command,
    current,
    next,
    context,
    now,
    receiptId,
    auditId,
    outboxId,
    proofProjection,
  } = input;
  const conditions = [
    `EXISTS (
       SELECT 1 FROM workflow_command_receipts
       WHERE id = ? AND organization_id = ?
     )`,
    `EXISTS (
       SELECT 1 FROM audit_events
       WHERE id = ? AND organization_id = ?
     )`,
    `EXISTS (
       SELECT 1 FROM outbox_events
       WHERE id = ? AND organization_id = ?
     )`,
  ];
  const values: Array<string | number | null> = [
    receiptId,
    context.organizationId,
    auditId,
    context.organizationId,
    outboxId,
    context.organizationId,
  ];
  const requireProjection = (
    sql: string,
    ...projectionValues: Array<string | number | null>
  ) => {
    conditions.push(sql);
    values.push(...projectionValues);
  };

  switch (command.type) {
    case "RUN_TRIAGE":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM service_requests
           WHERE organization_id = ? AND id = ? AND status = 'NEEDS_REVIEW'
             AND triage_json IS NOT NULL
         )`,
        context.organizationId,
        current.serviceRequestId,
      );
      break;
    case "APPROVE_TRIAGE":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM service_requests
           WHERE organization_id = ? AND id = ?
             AND status = 'READY_TO_SCHEDULE'
         )`,
        context.organizationId,
        current.serviceRequestId,
      );
      break;
    case "APPROVE_SCHEDULE":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM appointments
           WHERE organization_id = ? AND job_id = ?
             AND technician_id = ? AND status = 'CONFIRMED'
         )`,
        context.organizationId,
        current.jobId,
        next.assignedTechnicianId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM jobs
           WHERE organization_id = ? AND id = ?
             AND technician_id = ? AND status = 'SCHEDULED'
         )`,
        context.organizationId,
        current.jobId,
        next.assignedTechnicianId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM service_requests
           WHERE organization_id = ? AND id = ? AND status = 'SCHEDULED'
         )`,
        context.organizationId,
        current.serviceRequestId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM schedule_candidates
           WHERE organization_id = ? AND id = ? AND approved_at IS NOT NULL
         )`,
        context.organizationId,
        command.candidateId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM margin_snapshots
           WHERE organization_id = ? AND job_id = ?
             AND phase = 'EXPECTED_AT_BOOKING'
         )`,
        context.organizationId,
        current.jobId,
      );
      break;
    case "CHECK_IN":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM jobs
           WHERE organization_id = ? AND id = ?
             AND technician_id = ? AND status = 'IN_PROGRESS'
             AND checked_in_at IS NOT NULL
         )`,
        context.organizationId,
        current.jobId,
        current.assignedTechnicianId,
      );
      break;
    case "ADD_OBSERVATION":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM observations
           WHERE organization_id = ? AND job_id = ? AND category = ?
             AND note = ? AND created_at = ?
         )`,
        context.organizationId,
        current.jobId,
        command.category,
        command.note,
        now,
      );
      break;
    case "COMPLETE_JOB":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM jobs
           WHERE organization_id = ? AND id = ?
             AND technician_id = ? AND status = 'FIELD_WORK_COMPLETE'
             AND completed_at = ?
         )`,
        context.organizationId,
        current.jobId,
        current.assignedTechnicianId,
        now,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM service_outcomes
           WHERE organization_id = ? AND job_id = ?
             AND status = 'PENDING_VERIFICATION'
         )`,
        context.organizationId,
        current.jobId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM outcome_checkpoints
           WHERE organization_id = ? AND job_id = ? AND status = 'PENDING'
         )`,
        context.organizationId,
        current.jobId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM margin_snapshots
           WHERE organization_id = ? AND job_id = ?
             AND phase = 'ACTUAL_AT_COMPLETION'
         )`,
        context.organizationId,
        current.jobId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM service_proofs
           WHERE organization_id = ? AND job_id = ? AND id = ?
             AND sha256 = ?
         )`,
        context.organizationId,
        current.jobId,
        next.proofId,
        proofProjection?.sha256 ?? null,
      );
      if (next.followUpCreated) {
        requireProjection(
          `EXISTS (
             SELECT 1 FROM follow_ups
             WHERE organization_id = ? AND job_id = ? AND status = 'OPEN'
           )`,
          context.organizationId,
          current.jobId,
        );
        requireProjection(
          `EXISTS (
             SELECT 1 FROM exception_records
             WHERE organization_id = ? AND job_id = ? AND status = 'OPEN'
           )`,
          context.organizationId,
          current.jobId,
        );
      }
      break;
    case "SEND_PROOF":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM proof_deliveries
           WHERE organization_id = ? AND job_id = ? AND report_id = ?
             AND idempotency_key = ? AND status = 'QUEUED'
         )`,
        context.organizationId,
        current.jobId,
        next.proofId,
        command.commandId,
      );
      break;
    case "VERIFY_OUTCOME":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM service_outcomes
           WHERE organization_id = ? AND job_id = ? AND status = ?
             AND verified_by_user_id = ? AND verification_source = ?
         )`,
        context.organizationId,
        current.jobId,
        next.outcome,
        context.actorId,
        command.source,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM outcome_checkpoints
           WHERE organization_id = ? AND job_id = ? AND status = 'COMPLETED'
             AND verified_by_user_id = ?
         )`,
        context.organizationId,
        current.jobId,
        context.actorId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM margin_snapshots
           WHERE organization_id = ? AND job_id = ?
             AND phase = 'FINAL_AFTER_OUTCOME'
         )`,
        context.organizationId,
        current.jobId,
      );
      break;
    case "RECORD_RESERVICE":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM jobs
           WHERE organization_id = ? AND id = ? AND kind = 'RESERVICE'
             AND parent_job_id = ?
         )`,
        context.organizationId,
        command.reserviceJobId,
        current.jobId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM reservice_events
           WHERE organization_id = ? AND original_job_id = ?
             AND reservice_job_id = ? AND cost_cents = ?
         )`,
        context.organizationId,
        current.jobId,
        command.reserviceJobId,
        command.directCostCents,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM service_outcomes
           WHERE organization_id = ? AND job_id = ?
             AND status = 'RESERVICE_REQUIRED'
         )`,
        context.organizationId,
        current.jobId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM margin_snapshots
           WHERE organization_id = ? AND job_id = ?
             AND phase = 'FINAL_AFTER_OUTCOME'
             AND actual_reservice_cost_cents = ?
         )`,
        context.organizationId,
        current.jobId,
        next.actualReserviceCostCents,
      );
      break;
    case "RESOLVE_EXCEPTION":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM follow_ups
           WHERE organization_id = ? AND job_id = ? AND status = 'RESOLVED'
             AND owner_user_id = ?
         )`,
        context.organizationId,
        current.jobId,
        command.ownerUserId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM exception_records
           WHERE organization_id = ? AND job_id = ? AND status = 'RESOLVED'
             AND owner_user_id = ?
         )`,
        context.organizationId,
        current.jobId,
        command.ownerUserId,
      );
      break;
    case "RESET_DEMO":
      requireProjection(
        `EXISTS (
           SELECT 1 FROM jobs
           WHERE organization_id = ? AND id = ? AND status = 'DRAFT'
             AND technician_id IS NULL
         )`,
        context.organizationId,
        current.jobId,
      );
      requireProjection(
        `EXISTS (
           SELECT 1 FROM service_requests
           WHERE organization_id = ? AND id = ? AND status = 'NEW'
         )`,
        context.organizationId,
        current.serviceRequestId,
      );
      requireProjection(
        `NOT EXISTS (
           SELECT 1 FROM jobs
           WHERE organization_id = ? AND kind = 'RESERVICE'
             AND parent_job_id = ?
         )`,
        context.organizationId,
        current.jobId,
      );
      requireProjection(
        `NOT EXISTS (
           SELECT 1 FROM outbox_events
           WHERE organization_id = ?
             AND event_type = 'SERVICE_PROOF_DELIVERY_QUEUED'
             AND json_extract(payload_json, '$.workflowId') = ?
         )`,
        context.organizationId,
        current.workflowId,
      );
      break;
    case "SET_CHECKLIST_STEP":
    case "REVIEW_RISK":
      break;
  }

  return env.DB.prepare(
    `SELECT CASE
       WHEN ${conditions.join("\n         AND ")}
       THEN 1
       ELSE json('FIELDPROOF_PROJECTION_ASSERTION_FAILED')
     END AS projection_ok`,
  ).bind(...values);
}

function marginStatement(
  context: RequestContext,
  jobId: string,
  economics:
    | NonNullable<WorkflowSnapshot["expectedEconomics"]>
    | NonNullable<WorkflowSnapshot["actualEconomics"]>
    | NonNullable<WorkflowSnapshot["finalEconomics"]>,
  now: number,
  receiptId: string,
) {
  const gate = `EXISTS (
    SELECT 1 FROM workflow_command_receipts
    WHERE id = ? AND organization_id = ?
  )`;
  return env.DB.prepare(
    `INSERT INTO margin_snapshots
      (id, organization_id, job_id, phase, revenue, labor_cost, drive_cost,
       material_cost, expected_reservice_cost, contribution_margin,
       revenue_cents, labor_minutes, labor_cost_cents, drive_minutes,
       drive_cost_cents, material_cost_cents, expected_reservice_cost_cents,
       actual_reservice_cost_cents, contribution_margin_cents, source_json,
       created_at, updated_at, version)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, 1 WHERE ${gate}
     ON CONFLICT(organization_id, job_id, phase) DO UPDATE SET
       revenue = excluded.revenue,
       labor_cost = excluded.labor_cost,
       drive_cost = excluded.drive_cost,
       material_cost = excluded.material_cost,
       expected_reservice_cost = excluded.expected_reservice_cost,
       contribution_margin = excluded.contribution_margin,
       revenue_cents = excluded.revenue_cents,
       labor_minutes = excluded.labor_minutes,
       labor_cost_cents = excluded.labor_cost_cents,
       drive_minutes = excluded.drive_minutes,
       drive_cost_cents = excluded.drive_cost_cents,
       material_cost_cents = excluded.material_cost_cents,
       expected_reservice_cost_cents =
         excluded.expected_reservice_cost_cents,
       actual_reservice_cost_cents = excluded.actual_reservice_cost_cents,
       contribution_margin_cents = excluded.contribution_margin_cents,
       source_json = excluded.source_json,
       updated_at = excluded.updated_at,
       version = margin_snapshots.version + 1`,
  ).bind(
    `MARGIN-${jobId}-${economics.phase}`,
    context.organizationId,
    jobId,
    economics.phase,
    economics.revenueCents / 100,
    economics.laborCostCents / 100,
    economics.driveCostCents / 100,
    economics.materialCostCents / 100,
    economics.expectedReserviceCostCents / 100,
    economics.contributionMarginCents / 100,
    economics.revenueCents,
    economics.laborMinutes,
    economics.laborCostCents,
    economics.driveMinutes,
    economics.driveCostCents,
    economics.materialCostCents,
    economics.expectedReserviceCostCents,
    economics.actualReserviceCostCents,
    economics.contributionMarginCents,
    JSON.stringify({
      policyVersion: "economics-v2",
      phase: economics.phase,
      actorId: context.actorId,
    }),
    now,
    now,
    receiptId,
    context.organizationId,
  );
}

async function createProofProjection(
  snapshot: WorkflowSnapshot,
  context: RequestContext,
) {
  const appointment = await env.DB.prepare(
    `SELECT id, starts_at, duration_minutes, technician_id
     FROM appointments
     WHERE organization_id = ? AND job_id = ? AND status = 'CONFIRMED'
     ORDER BY starts_at DESC LIMIT 1`,
  )
    .bind(context.organizationId, snapshot.jobId)
    .first<{
      id: string;
      starts_at: number;
      duration_minutes: number;
      technician_id: string;
    }>();
  if (
    !appointment ||
    appointment.technician_id !== snapshot.assignedTechnicianId
  ) {
    throw new Error(
      "The persisted confirmed appointment was unavailable for proof generation.",
    );
  }
  const canonical = {
    schemaVersion: "service-proof-v1",
    reportId: snapshot.proofId,
    revision: snapshot.proofRevision,
    organizationId: context.organizationId,
    jobId: snapshot.jobId,
    propertyId: snapshot.propertyId,
    playbookVersionId: snapshot.playbookVersionId,
    appointment: {
      id: appointment.id,
      startsAt: new Date(appointment.starts_at).toISOString(),
      durationMinutes: appointment.duration_minutes,
      technicianId: appointment.technician_id,
    },
    technicianId: snapshot.assignedTechnicianId,
    checklist: snapshot.checklist,
    evidence: snapshot.evidence.map((item) => ({
      id: item.id,
      phase: item.phase,
      subject: item.subject,
      zoneId: item.zoneId,
      sha256: item.sha256,
      capturedAt: item.capturedAt,
      caption: item.caption,
    })),
    observation: {
      category: snapshot.observationCategory,
      note: snapshot.observation,
    },
    technicianAssessment: snapshot.technicianAssessment,
    outcomeStatus: "PENDING_VERIFICATION",
    followUpCreated: snapshot.followUpCreated,
    generatedAt: snapshot.completedAt,
  };
  const canonicalJson = JSON.stringify(canonical);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson),
  );
  const sha256 = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return { canonicalJson, sha256 };
}

function workflowStorageId(organizationId: string, workflowId: string) {
  return `${organizationId}:${workflowId}`;
}

function conflict(correlationId: string, code: string, message: string) {
  return Response.json(
    { error: { code, message, correlationId } },
    { status: 409 },
  );
}

function versionConflict(
  correlationId: string,
  current: WorkflowSnapshot,
) {
  return Response.json(
    {
      error: {
        code: "VERSION_CONFLICT",
        message: "The workflow changed. Refresh and retry the command.",
        correlationId,
        currentVersion: current.version,
      },
    },
    { status: 409 },
  );
}

function serverError(correlationId: string, error?: unknown) {
  console.error(
    JSON.stringify({
      level: "error",
      service: "workflow",
      correlationId,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: "UnknownError" },
    }),
  );
  return Response.json(
    {
      error: {
        code: "WORKFLOW_UNAVAILABLE",
        message: "The workflow service is temporarily unavailable.",
        correlationId,
      },
    },
    { status: 503 },
  );
}
