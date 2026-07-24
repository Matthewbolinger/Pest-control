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
  authorizePermission,
  contextDenied,
  getRequestContext,
  isCrossSiteMutation,
  type RequestContext,
} from "@/app/api/v1/request-context";

const Metadata = z
  .object({
    jobId: z.string().trim().min(1).max(128),
    propertyId: z.string().trim().min(1).max(128),
    zoneId: z.string().trim().min(1).max(128),
    phase: z.enum(["BEFORE", "DURING", "AFTER"]),
    subject: z.enum([
      "AREA_OVERVIEW",
      "PEST_EVIDENCE",
      "ENTRY_POINT",
      "WORK_PERFORMED",
      "OTHER",
    ]),
    caption: z.string().trim().max(240).nullable(),
    capturedAt: z.coerce.number().int().nonnegative(),
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
  kind: "FIELD_PHOTO";
  phase: EvidenceRecord["phase"];
  subject: EvidenceRecord["subject"];
  caption: string | null;
  content_type: SupportedEvidenceType;
  sha256: string;
  captured_at: number;
  uploaded_at: number;
};

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  const resolution = await getRequestContext(request, env.DB);
  if (!resolution.context) return contextDenied(resolution, correlationId);
  const context = resolution.context;

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
              kind, phase, subject, caption, content_type, sha256, captured_at,
              updated_at AS uploaded_at
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
        await assignedTechnicianForEvidence(
          context.organizationId,
          row.job_id,
        ),
      );
      if (assignedDenied) return assignedDenied;
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
  const resolution = await getRequestContext(request, env.DB);
  if (!resolution.context) return contextDenied(resolution, correlationId);
  const context = resolution.context;
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
    phase: form.get("phase"),
    subject: form.get("subject"),
    caption:
      typeof form.get("caption") === "string" && form.get("caption")
        ? form.get("caption")
        : null,
    capturedAt: form.get("capturedAt"),
  });
  if (
    !(file instanceof File) ||
    !metadata.success ||
    file.size <= 0 ||
    file.size > MAXIMUM_EVIDENCE_BYTES
  ) {
    return invalidEvidence(correlationId);
  }
  if (
    metadata.data.capturedAt > Date.now() + 5 * 60 * 1000 ||
    metadata.data.capturedAt < Date.now() - 30 * 24 * 60 * 60 * 1000
  ) {
    return apiError(
      400,
      correlationId,
      "INVALID_CAPTURE_TIME",
      "Evidence capture time must be within the last 30 days and not in the future.",
    );
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
    if (
      metadata.data.jobId !== current.jobId ||
      metadata.data.propertyId !== current.propertyId
    ) {
      return apiError(
        404,
        correlationId,
        "FIELD_RECORD_NOT_FOUND",
        "The job, property, or zone was not found in the active organization.",
      );
    }
    const relationshipsValid = await validateEvidenceRelationships(
      context.organizationId,
      metadata.data,
      current.assignedTechnicianId,
    );
    if (!relationshipsValid) {
      return apiError(
        404,
        correlationId,
        "FIELD_RECORD_NOT_FOUND",
        "The job, property, or zone was not found in the active organization.",
      );
    }
    const denied = authorizePermission(
      context,
      "EVIDENCE_UPLOAD_ASSIGNED",
      correlationId,
      current.assignedTechnicianId,
    );
    if (denied) return denied;

    const id = `EV-${crypto.randomUUID()}`;
    const uploadedAt = Date.now();
    const capturedAt = metadata.data.capturedAt;
    const commandId = `EVIDENCE:${idempotency.data}`;
    const record: EvidenceRecord = {
      id,
      kind: "FIELD_PHOTO",
      phase: metadata.data.phase,
      subject: metadata.data.subject,
      caption: metadata.data.caption,
      contentType: detectedType,
      sha256,
      capturedAt,
      uploadedAt,
      zoneId: metadata.data.zoneId,
    };
    let next: WorkflowSnapshot;
    try {
      next = appendEvidenceRecord(
        current,
        record,
        commandId,
        new Date(uploadedAt).toISOString(),
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
        phase: record.phase,
        subject: record.subject,
        capturedAt: String(record.capturedAt),
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
  const now = record.uploadedAt ?? Date.now();
  const commandId = `EVIDENCE:${idempotencyKey}`;
  const responseJson = JSON.stringify(next);
  const storageId = workflowStorageId(
    context.organizationId,
    current.workflowId,
  );
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO evidence_assets
        (id, organization_id, idempotency_key, job_id, property_id, zone_id,
         technician_id, object_key, kind, phase, subject, caption,
         uploaded_by_user_id, content_type, sha256, captured_at, created_at,
         updated_at, version)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'FIELD_PHOTO', ?, ?, ?, ?, ?, ?, ?, ?,
              ?, 1
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
      record.phase,
      record.subject,
      record.caption,
      context.actorId,
      record.contentType,
      record.sha256,
      record.capturedAt,
      now,
      now,
      storageId,
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
      storageId,
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
      storageId,
      commandId,
      JSON.stringify({
        idempotencyKey,
        jobId: current.jobId,
        propertyId: current.propertyId,
        zoneId: record.zoneId,
        phase: record.phase,
        subject: record.subject,
        caption: record.caption,
        capturedAt: record.capturedAt,
        sha256: record.sha256,
      }),
      responseJson,
      next.version,
      now,
      storageId,
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
      `${record.phase} ${record.subject} evidence ${record.id} was attributed to ${current.assignedTechnicianId}.`,
      "evidence-ledger-v2",
      JSON.stringify(current),
      responseJson,
      storageId,
      context.organizationId,
      next.version,
      commandId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO outbox_events
        (id, organization_id, event_type, entity_id, payload_json,
         idempotency_key, status, attempts, available_at, last_error,
         processed_at, created_at, updated_at, version)
       SELECT ?, ?, 'EVIDENCE_CAPTURED', ?, ?, ?, 'PROCESSED', 1, ?, NULL,
              ?, ?, ?, 1
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
        phase: record.phase,
        subject: record.subject,
        version: next.version,
      }),
      `${context.organizationId}:${current.workflowId}:${commandId}`,
      now,
      now,
      now,
      now,
      storageId,
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
    .bind(workflowStorageId(organizationId, FIELDPROOF_DEMO.workflowId), organizationId)
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
            kind, phase, subject, caption, content_type, sha256, captured_at,
            updated_at AS uploaded_at
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
    row.phase === metadata.phase &&
    row.subject === metadata.subject &&
    row.caption === metadata.caption &&
    row.captured_at === metadata.capturedAt &&
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
    phase: row.phase,
    subject: row.subject,
    caption: row.caption,
    contentType: row.content_type,
    sha256: row.sha256,
    capturedAt: row.captured_at,
    uploadedAt: row.uploaded_at,
    zoneId: row.zone_id,
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

async function assignedTechnicianForEvidence(
  organizationId: string,
  jobId: string,
) {
  const row = await env.DB.prepare(
    `SELECT technician_id FROM jobs
     WHERE organization_id = ? AND id = ?`,
  )
    .bind(organizationId, jobId)
    .first<{ technician_id: string | null }>();
  return row?.technician_id ?? null;
}

async function validateEvidenceRelationships(
  organizationId: string,
  metadata: z.infer<typeof Metadata>,
  assignedTechnicianId: string,
) {
  const row = await env.DB.prepare(
    `SELECT j.id
     FROM jobs j
     JOIN properties p
       ON p.organization_id = j.organization_id
      AND p.id = j.property_id
     JOIN property_zones z
       ON z.organization_id = p.organization_id
      AND z.property_id = p.id
     WHERE j.organization_id = ? AND j.id = ? AND p.id = ? AND z.id = ?
       AND j.technician_id = ?
     LIMIT 1`,
  )
    .bind(
      organizationId,
      metadata.jobId,
      metadata.propertyId,
      metadata.zoneId,
      assignedTechnicianId,
    )
    .first();
  return Boolean(row);
}

function workflowStorageId(organizationId: string, workflowId: string) {
  return `${organizationId}:${workflowId}`;
}
