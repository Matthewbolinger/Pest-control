import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  detectEvidenceContentType,
  evidenceExtension,
  MAXIMUM_EVIDENCE_BYTES,
  type SupportedEvidenceType,
} from "@/packages/application/evidence";
import {
  appendEvidenceRecord,
  FIELDPROOF_DEMO,
  WorkflowSnapshotSchema,
  WorkflowTransitionError,
  type EvidenceRecord,
  type WorkflowSnapshot,
} from "@/packages/application/workflow";
import {
  getRequestContext,
  isCrossSiteMutation,
  unauthorized,
  type RequestContext,
} from "@/app/api/v1/request-context";

const Metadata = z
  .object({
    jobId: z.literal(FIELDPROOF_DEMO.jobId),
    propertyId: z.literal(FIELDPROOF_DEMO.propertyId),
    zoneId: z.enum(FIELDPROOF_DEMO.zoneIds),
  })
  .strict();

const EvidenceId = z.string().regex(/^EV-[0-9a-f-]{36}$/i);
const IdempotencyKey = z
  .string()
  .min(8)
  .max(96)
  .regex(/^[A-Za-z0-9:_-]+$/);

type SnapshotRow = {
  snapshot_json: string;
  version: number;
};

type EvidenceRow = {
  id: string;
  idempotency_key: string;
  job_id: string;
  property_id: string;
  zone_id: string;
  object_key: string;
  content_type: SupportedEvidenceType;
  sha256: string;
  captured_at: number;
};

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  const context = getRequestContext(request);
  if (!context) return unauthorized(correlationId);

  const id = EvidenceId.safeParse(new URL(request.url).searchParams.get("id"));
  if (!id.success) {
    return apiError(
      400,
      correlationId,
      "VALIDATION_ERROR",
      "A valid evidence id is required.",
    );
  }

  try {
    const row = await env.DB.prepare(
      `SELECT id, idempotency_key, job_id, property_id, zone_id, object_key,
              content_type, sha256, captured_at
       FROM evidence_assets
       WHERE organization_id = ? AND id = ?`,
    )
      .bind(context.organizationId, id.data)
      .first<EvidenceRow>();
    if (!row) {
      return apiError(
        404,
        correlationId,
        "EVIDENCE_NOT_FOUND",
        "The evidence record was not found.",
      );
    }

    const object = await env.EVIDENCE.get(row.object_key);
    if (!object) {
      return apiError(
        404,
        correlationId,
        "EVIDENCE_OBJECT_NOT_FOUND",
        "The evidence object was not found.",
      );
    }

    return new Response(object.body as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": row.content_type,
        "content-length": String(object.size),
        "cache-control": "private, no-store",
        "content-disposition": `inline; filename="${row.id}.${evidenceExtension(row.content_type)}"`,
        "x-content-type-options": "nosniff",
        "x-evidence-sha256": row.sha256,
        "x-correlation-id": correlationId,
      },
    });
  } catch {
    return apiError(
      503,
      correlationId,
      "EVIDENCE_UNAVAILABLE",
      "Evidence retrieval is temporarily unavailable.",
    );
  }
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const context = getRequestContext(request);
  if (!context) return unauthorized(correlationId);
  if (isCrossSiteMutation(request)) {
    return apiError(
      403,
      correlationId,
      "CROSS_SITE_WRITE_REJECTED",
      "Cross-site evidence uploads are not allowed.",
    );
  }

  const idempotency = IdempotencyKey.safeParse(
    request.headers.get("idempotency-key"),
  );
  if (!idempotency.success) {
    return apiError(
      400,
      correlationId,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Provide a stable Idempotency-Key header.",
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return invalidEvidence(correlationId);
  }
  const file = form.get("file");
  const metadata = Metadata.safeParse({
    jobId: form.get("jobId"),
    propertyId: form.get("propertyId"),
    zoneId: form.get("zoneId"),
  });
  if (
    !(file instanceof File) ||
    !metadata.success ||
    file.size <= 0 ||
    file.size > MAXIMUM_EVIDENCE_BYTES
  ) {
    return invalidEvidence(correlationId);
  }

  const bytes = await file.arrayBuffer();
  const detectedType = detectEvidenceContentType(bytes);
  if (!detectedType || file.type !== detectedType) {
    return invalidEvidence(correlationId);
  }

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

  try {
    const existing = await findEvidence(
      context.organizationId,
      idempotency.data,
    );
    if (existing) {
      if (!sameEvidenceRequest(existing, metadata.data, sha256)) {
        return apiError(
          409,
          correlationId,
          "IDEMPOTENCY_KEY_REUSED",
          "That Idempotency-Key was already used for different evidence.",
        );
      }
      return evidenceResponse(
        existing,
        await loadSnapshot(context.organizationId),
        correlationId,
        true,
      );
    }

    const current = await loadSnapshot(context.organizationId);
    if (
      !current.scheduled ||
      !current.checkedIn ||
      current.completed ||
      !current.assignedTechnicianId
    ) {
      return apiError(
        409,
        correlationId,
        "INVALID_TRANSITION",
        "Evidence requires an active, checked-in job with an assigned technician.",
      );
    }

    const id = `EV-${crypto.randomUUID()}`;
    const capturedAt = Date.now();
    const commandId = `EVIDENCE:${idempotency.data}`;
    const record: EvidenceRecord = {
      id,
      kind: "FIELD_PHOTO",
      contentType: detectedType,
      sha256,
      capturedAt,
      zoneId: metadata.data.zoneId,
    };
    let next: WorkflowSnapshot;
    try {
      next = appendEvidenceRecord(
        current,
        record,
        commandId,
        new Date(capturedAt).toISOString(),
      );
    } catch (error) {
      if (error instanceof WorkflowTransitionError) {
        return apiError(
          409,
          correlationId,
          error.code,
          error.message,
        );
      }
      throw error;
    }

    const objectKey = `${context.organizationId}/${current.jobId}/${id}.${evidenceExtension(detectedType)}`;
    await env.EVIDENCE.put(objectKey, bytes, {
      httpMetadata: { contentType: detectedType },
      customMetadata: {
        organizationId: context.organizationId,
        jobId: current.jobId,
        propertyId: current.propertyId,
        zoneId: metadata.data.zoneId,
        technicianId: current.assignedTechnicianId,
        sha256,
      },
    });

    try {
      const results = await persistEvidence({
        context,
        current,
        next,
        record,
        idempotencyKey: idempotency.data,
        objectKey,
        correlationId,
      });
      const inserted = Number(results[0]?.meta?.changes ?? 0);
      const updated = Number(results[1]?.meta?.changes ?? 0);
      if (inserted !== 1 || updated !== 1) {
        await env.EVIDENCE.delete(objectKey);
        const raced = await findEvidence(
          context.organizationId,
          idempotency.data,
        );
        if (
          raced &&
          sameEvidenceRequest(raced, metadata.data, sha256)
        ) {
          return evidenceResponse(
            raced,
            await loadSnapshot(context.organizationId),
            correlationId,
            true,
          );
        }
        return apiError(
          409,
          correlationId,
          "VERSION_CONFLICT",
          "The workflow changed while evidence was uploading. Refresh and retry.",
        );
      }
    } catch {
      await env.EVIDENCE.delete(objectKey);
      const raced = await findEvidence(
        context.organizationId,
        idempotency.data,
      );
      if (
        raced &&
        sameEvidenceRequest(raced, metadata.data, sha256)
      ) {
        return evidenceResponse(
          raced,
          await loadSnapshot(context.organizationId),
          correlationId,
          true,
        );
      }
      throw new Error("Evidence persistence failed.");
    }

    return Response.json(
      {
        data: { record, snapshot: next },
        correlationId,
        idempotent: false,
      },
      { status: 201 },
    );
  } catch {
    return apiError(
      503,
      correlationId,
      "EVIDENCE_UNAVAILABLE",
      "Evidence storage is temporarily unavailable.",
    );
  }
}

async function persistEvidence(input: {
  context: RequestContext;
  current: WorkflowSnapshot;
  next: WorkflowSnapshot;
  record: EvidenceRecord;
  idempotencyKey: string;
  objectKey: string;
  correlationId: string;
}) {
  const {
    context,
    current,
    next,
    record,
    idempotencyKey,
    objectKey,
    correlationId,
  } = input;
  const now = record.capturedAt;
  const commandId = `EVIDENCE:${idempotencyKey}`;
  const responseJson = JSON.stringify(next);
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO evidence_assets
        (id, organization_id, idempotency_key, job_id, property_id, zone_id,
         technician_id, object_key, kind, content_type, sha256, captured_at,
         created_at, updated_at, version)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'FIELD_PHOTO', ?, ?, ?, ?, ?, 1
       WHERE EXISTS (
         SELECT 1 FROM workflow_snapshots
         WHERE id = ? AND organization_id = ? AND version = ?
           AND assigned_technician_id = ?
       )`,
    ).bind(
      record.id,
      context.organizationId,
      idempotencyKey,
      current.jobId,
      current.propertyId,
      record.zoneId,
      current.assignedTechnicianId,
      objectKey,
      record.contentType,
      record.sha256,
      record.capturedAt,
      now,
      now,
      current.workflowId,
      context.organizationId,
      current.version,
      current.assignedTechnicianId,
    ),
    env.DB.prepare(
      `UPDATE workflow_snapshots
       SET snapshot_json = ?, last_command_id = ?, updated_at = ?, version = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND EXISTS (
           SELECT 1 FROM evidence_assets
           WHERE id = ? AND organization_id = ?
         )`,
    ).bind(
      responseJson,
      commandId,
      now,
      next.version,
      current.workflowId,
      context.organizationId,
      current.version,
      record.id,
      context.organizationId,
    ),
    env.DB.prepare(
      `INSERT INTO workflow_command_receipts
        (id, organization_id, workflow_id, command_id, command_type,
         request_json, response_json, applied_version, created_at)
       SELECT ?, ?, ?, ?, 'ADD_EVIDENCE', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM workflow_snapshots
         WHERE id = ? AND organization_id = ? AND version = ?
           AND last_command_id = ?
       )`,
    ).bind(
      `WCR-${crypto.randomUUID()}`,
      context.organizationId,
      current.workflowId,
      commandId,
      JSON.stringify({
        idempotencyKey,
        jobId: current.jobId,
        propertyId: current.propertyId,
        zoneId: record.zoneId,
        sha256: record.sha256,
      }),
      responseJson,
      next.version,
      now,
      current.workflowId,
      context.organizationId,
      next.version,
      commandId,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, organization_id, actor_type, actor_id, action, entity_type,
         entity_id, occurred_at, correlation_id, reason, policy_version,
         previous_json, next_json)
       SELECT ?, ?, ?, ?, 'EVIDENCE_CAPTURED', 'JOB', ?, ?, ?, ?, ?,
              ?, ?
       WHERE EXISTS (
         SELECT 1 FROM workflow_snapshots
         WHERE id = ? AND organization_id = ? AND version = ?
           AND last_command_id = ?
       )`,
    ).bind(
      `AUD-${crypto.randomUUID()}`,
      context.organizationId,
      context.actorType,
      context.actorId,
      current.jobId,
      now,
      correlationId,
      `Evidence ${record.id} was attributed to ${current.assignedTechnicianId}.`,
      "evidence-ledger-v2",
      JSON.stringify(current),
      responseJson,
      current.workflowId,
      context.organizationId,
      next.version,
      commandId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO outbox_events
        (id, organization_id, event_type, entity_id, payload_json,
         idempotency_key, status, attempts, available_at, created_at,
         updated_at, version)
       SELECT ?, ?, 'EVIDENCE_CAPTURED', ?, ?, ?, 'PENDING', 0, ?, ?, ?, 1
       WHERE EXISTS (
         SELECT 1 FROM workflow_snapshots
         WHERE id = ? AND organization_id = ? AND version = ?
           AND last_command_id = ?
       )`,
    ).bind(
      `OUT-${crypto.randomUUID()}`,
      context.organizationId,
      current.jobId,
      JSON.stringify({
        workflowId: current.workflowId,
        evidenceId: record.id,
        version: next.version,
      }),
      `${context.organizationId}:${current.workflowId}:${commandId}`,
      now,
      now,
      now,
      current.workflowId,
      context.organizationId,
      next.version,
      commandId,
    ),
  ]);
}

async function loadSnapshot(organizationId: string) {
  const row = await env.DB.prepare(
    `SELECT snapshot_json, version FROM workflow_snapshots
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(FIELDPROOF_DEMO.workflowId, organizationId)
    .first<SnapshotRow>();
  if (!row) {
    throw new Error("The workflow must be loaded before evidence is captured.");
  }
  const snapshot = WorkflowSnapshotSchema.parse(JSON.parse(row.snapshot_json));
  if (snapshot.version !== row.version) {
    throw new Error("Workflow snapshot version is inconsistent.");
  }
  return snapshot;
}

async function findEvidence(
  organizationId: string,
  idempotencyKey: string,
) {
  return env.DB.prepare(
    `SELECT id, idempotency_key, job_id, property_id, zone_id, object_key,
            content_type, sha256, captured_at
     FROM evidence_assets
     WHERE organization_id = ? AND idempotency_key = ?`,
  )
    .bind(organizationId, idempotencyKey)
    .first<EvidenceRow>();
}

function sameEvidenceRequest(
  row: EvidenceRow,
  metadata: z.infer<typeof Metadata>,
  sha256: string,
) {
  return (
    row.job_id === metadata.jobId &&
    row.property_id === metadata.propertyId &&
    row.zone_id === metadata.zoneId &&
    row.sha256 === sha256
  );
}

function evidenceResponse(
  row: EvidenceRow,
  snapshot: WorkflowSnapshot,
  correlationId: string,
  idempotent: boolean,
) {
  const record: EvidenceRecord = {
    id: row.id,
    kind: "FIELD_PHOTO",
    contentType: row.content_type,
    sha256: row.sha256,
    capturedAt: row.captured_at,
    zoneId: "ZONE-BASEMENT",
  };
  return Response.json({
    data: { record, snapshot },
    correlationId,
    idempotent,
  });
}

function invalidEvidence(correlationId: string) {
  return apiError(
    400,
    correlationId,
    "INVALID_EVIDENCE",
    "Use a JPEG, PNG, or WebP image no larger than 10 MB whose bytes match its declared type.",
  );
}

function apiError(
  status: number,
  correlationId: string,
  code: string,
  message: string,
) {
  return Response.json(
    { error: { code, message, correlationId } },
    { status },
  );
}
