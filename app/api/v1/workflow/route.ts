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
import { huntleyCandidates } from "@/packages/domain";
import { MockAIProvider } from "@/packages/ai";
import {
  getRequestContext,
  isCrossSiteMutation,
  unauthorized,
  type RequestContext,
} from "@/app/api/v1/request-context";

type SnapshotRow = {
  snapshot_json: string;
  version: number;
};

type ReceiptRow = {
  request_json: string;
  response_json: string;
};

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  const context = getRequestContext(request);
  if (!context) return unauthorized(correlationId);

  try {
    const snapshot = await loadOrCreateSnapshot(context);
    return Response.json({ data: snapshot, correlationId });
  } catch {
    return serverError(correlationId);
  }
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const context = getRequestContext(request);
  if (!context) return unauthorized(correlationId);
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

    let next: WorkflowSnapshot;
    try {
      const triageProposal =
        command.type === "RUN_TRIAGE"
          ? await new MockAIProvider().triageServiceRequest({
              description:
                "Hi, we found what looks like mouse droppings along the basement wall this morning. We have a dog and our daughter plays down there. Can someone check it soon? We’re usually home after lunch.",
              propertyFacts: [
                "Residential single-family property.",
                "Huntley service territory.",
                "Active quarterly service plan.",
                "Existing Basement property zone.",
              ],
            })
          : undefined;
      next = applyWorkflowCommand(
        current,
        command,
        new Date().toISOString(),
        { triageProposal },
      );
    } catch (error) {
      if (error instanceof WorkflowTransitionError) {
        return conflict(correlationId, error.code, error.message);
      }
      throw error;
    }

    const now = Date.now();
    const event = eventFor(command);
    const responseJson = JSON.stringify(next);
    const requestBodyJson = JSON.stringify(command);
    const receiptId = `WCR-${crypto.randomUUID()}`;
    const auditId = `AUD-${crypto.randomUUID()}`;
    const outboxId = `OUT-${crypto.randomUUID()}`;
    const outboxKey = `${context.organizationId}:${FIELDPROOF_DEMO.workflowId}:${command.commandId}`;

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
        FIELDPROOF_DEMO.workflowId,
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
        FIELDPROOF_DEMO.workflowId,
        command.commandId,
        command.type,
        requestBodyJson,
        responseJson,
        next.version,
        now,
        FIELDPROOF_DEMO.workflowId,
        context.organizationId,
        next.version,
        command.commandId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, organization_id, actor_type, actor_id, action, entity_type,
           entity_id, occurred_at, correlation_id, reason, policy_version,
           previous_json, next_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        "workflow-policy-v1",
        JSON.stringify(current),
        responseJson,
        receiptId,
        context.organizationId,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO outbox_events
          (id, organization_id, event_type, entity_id, payload_json,
           idempotency_key, status, attempts, available_at, created_at,
           updated_at, version)
         SELECT ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, 1
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
          workflowId: FIELDPROOF_DEMO.workflowId,
          commandId: command.commandId,
          commandType: command.type,
          version: next.version,
        }),
        outboxKey,
        now,
        now,
        now,
        receiptId,
        context.organizationId,
      ),
      ...projectionStatements(command, next, context, now, receiptId),
    ];

    const results = await env.DB.batch(statements);
    const updated = Number(results[0]?.meta?.changes ?? 0);
    if (updated !== 1) {
      const racedReceipt = await findReceipt(
        context.organizationId,
        command.commandId,
      );
      if (
        racedReceipt &&
        racedReceipt.request_json === requestJson
      ) {
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
  } catch {
    return serverError(correlationId);
  }
}

async function loadOrCreateSnapshot(context: RequestContext) {
  const now = Date.now();
  const initial = createInitialWorkflowSnapshot(new Date(now).toISOString());
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_snapshots
      (id, organization_id, service_request_id, job_id, property_id,
       assigned_technician_id, snapshot_json, last_command_id, created_at,
       updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      initial.workflowId,
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
    `SELECT snapshot_json, version FROM workflow_snapshots
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(FIELDPROOF_DEMO.workflowId, context.organizationId)
    .first<SnapshotRow>();
  if (!row) throw new Error("Workflow snapshot was not available.");

  const snapshot = WorkflowSnapshotSchema.parse(JSON.parse(row.snapshot_json));
  if (snapshot.version !== row.version) {
    throw new Error("Workflow snapshot version is inconsistent.");
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
        reason: "Structured triage was generated for human review.",
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
        reason: "A structured field observation was recorded.",
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
        action: "JOB_COMPLETED",
        reason: "The server completion gate validated all required field proof.",
      };
    case "SEND_PROOF":
      return {
        ...common,
        entityType: "REPORT",
        entityId: "SP-2048",
        action: "SERVICE_PROOF_DELIVERY_QUEUED",
        reason:
          "The generated Service Proof was queued in the durable outbox; no delivery dispatcher is configured in this pilot.",
      };
    case "RESOLVE_EXCEPTION":
      return {
        ...common,
        action: "EXCEPTION_RESOLVED",
        reason: "The authenticated operator resolved the follow-up exception.",
      };
    case "RESET_DEMO":
      return {
        ...common,
        action: "DEMO_WORKFLOW_RESET",
        reason: "The authenticated operator reset the demo workflow snapshot.",
      };
  }
}

function projectionStatements(
  command: WorkflowCommand,
  next: WorkflowSnapshot,
  context: RequestContext,
  now: number,
  receiptId: string,
) {
  if (command.type === "RESOLVE_EXCEPTION") {
    const gate = `EXISTS (
      SELECT 1 FROM workflow_command_receipts
      WHERE id = ? AND organization_id = ?
    )`;
    return [
      env.DB.prepare(
        `INSERT INTO follow_ups
          (id, organization_id, job_id, property_id, due_at, reason, status,
           created_at, updated_at, version)
         SELECT ?, ?, ?, ?, ?, ?, 'RESOLVED', ?, ?, 1 WHERE ${gate}
         ON CONFLICT(id) DO UPDATE SET
           status = 'RESOLVED',
           updated_at = excluded.updated_at,
           version = follow_ups.version + 1`,
      ).bind(
        `FOLLOWUP-${FIELDPROOF_DEMO.jobId}`,
        context.organizationId,
        FIELDPROOF_DEMO.jobId,
        FIELDPROOF_DEMO.propertyId,
        now + 7 * 24 * 60 * 60 * 1000,
        "Verify the unresolved north sill-plate entry point.",
        now,
        now,
        receiptId,
        context.organizationId,
      ),
    ];
  }
  if (command.type !== "COMPLETE_JOB") return [];
  const candidate = huntleyCandidates.find(
    (item) => item.id === next.selectedCandidateId,
  );
  if (!candidate?.eligible) {
    throw new Error("Completed workflow has no eligible schedule candidate.");
  }
  const economics = candidate.economics;
  const gate = `EXISTS (
    SELECT 1 FROM workflow_command_receipts
    WHERE id = ? AND organization_id = ?
  )`;
  const statements = [
    env.DB.prepare(
      `INSERT INTO service_outcomes
        (id, organization_id, job_id, status, recurrence_risk_score,
         explanation_json, created_at, updated_at, version)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1 WHERE ${gate}
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         recurrence_risk_score = excluded.recurrence_risk_score,
         explanation_json = excluded.explanation_json,
         updated_at = excluded.updated_at,
         version = service_outcomes.version + 1`,
    ).bind(
      `OUTCOME-${FIELDPROOF_DEMO.jobId}`,
      context.organizationId,
      FIELDPROOF_DEMO.jobId,
      next.outcome,
      next.riskScore,
      JSON.stringify({
        riskReview: next.riskReview,
        source: "workflow-policy-v1",
      }),
      now,
      now,
      receiptId,
      context.organizationId,
    ),
    env.DB.prepare(
      `INSERT INTO margin_snapshots
        (id, organization_id, job_id, phase, revenue, labor_cost, drive_cost,
         material_cost, expected_reservice_cost, contribution_margin,
         created_at, updated_at, version)
       SELECT ?, ?, ?, 'REALIZED', ?, ?, ?, ?, ?, ?, ?, ?, 1 WHERE ${gate}
       ON CONFLICT(id) DO UPDATE SET
         revenue = excluded.revenue,
         labor_cost = excluded.labor_cost,
         drive_cost = excluded.drive_cost,
         material_cost = excluded.material_cost,
         expected_reservice_cost = excluded.expected_reservice_cost,
         contribution_margin = excluded.contribution_margin,
         updated_at = excluded.updated_at,
         version = margin_snapshots.version + 1`,
    ).bind(
      `MARGIN-${FIELDPROOF_DEMO.jobId}-REALIZED`,
      context.organizationId,
      FIELDPROOF_DEMO.jobId,
      economics.price,
      economics.laborCost,
      economics.driveCost,
      economics.materialEstimate,
      economics.expectedReserviceCost,
      economics.expectedContributionMargin,
      now,
      now,
      receiptId,
      context.organizationId,
    ),
  ];
  if (next.followUpCreated) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO follow_ups
          (id, organization_id, job_id, property_id, due_at, reason, status,
           created_at, updated_at, version)
         SELECT ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, 1 WHERE ${gate}
         ON CONFLICT(id) DO UPDATE SET
           due_at = excluded.due_at,
           reason = excluded.reason,
           status = 'OPEN',
           updated_at = excluded.updated_at,
           version = follow_ups.version + 1`,
      ).bind(
        `FOLLOWUP-${FIELDPROOF_DEMO.jobId}`,
        context.organizationId,
        FIELDPROOF_DEMO.jobId,
        FIELDPROOF_DEMO.propertyId,
        now + 7 * 24 * 60 * 60 * 1000,
        "Verify the unresolved north sill-plate entry point.",
        now,
        now,
        receiptId,
        context.organizationId,
      ),
    );
  }
  return statements;
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

function serverError(correlationId: string) {
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
