import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  MockFSMAdapter,
  PROVIDER_CAPABILITIES,
} from "@/packages/integrations";
import {
  authorizePermission,
  contextDenied,
  getRequestContext,
  isCrossSiteMutation,
} from "@/app/api/v1/request-context";
import { PILOT_RECORDS } from "@/app/api/v1/pilot-data";

const SyncRequestSchema = z
  .object({
    type: z.literal("RUN_MOCK_SYNC"),
    idempotencyKey: z
      .string()
      .min(8)
      .max(96)
      .regex(/^[A-Za-z0-9:._-]+$/),
    simulateFailure: z.boolean().default(false),
  })
  .strict();

type PriorSync = {
  request_json: string;
  result_json: string;
};

type MappingRow = {
  external_id: string;
  internal_id: string;
  external_version: string | null;
};

type RequiredWrite = {
  index: number;
  label: string;
};

const MOCK_JOB_ITEMS = [
  {
    externalId: "fsm-job-2048",
    fingerprint: "job-2048-v1",
    validationErrors: [],
  },
  {
    externalId: "fsm-job-2049",
    fingerprint: "job-2049-v1",
    validationErrors: [],
  },
  {
    externalId: "fsm-job-invalid",
    fingerprint: "job-invalid-v1",
    validationErrors: ["property external id is missing"],
  },
] as const;

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  try {
    const resolution = await getRequestContext(request, env.DB);
    if (!resolution.context) return contextDenied(resolution, correlationId);
    const context = resolution.context;
    const denied = authorizePermission(
      context,
      "INTEGRATION_MANAGE",
      correlationId,
    );
    if (denied) return denied;

    const [connections, syncs, errors] = await Promise.all([
      env.DB.prepare(
        `SELECT id, provider, mode, status, capabilities_json,
                last_successful_sync_at, version
         FROM integration_connections
         WHERE organization_id = ?
         ORDER BY provider`,
      )
        .bind(context.organizationId)
        .all(),
      env.DB.prepare(
        `SELECT id, connection_id, direction, status, cursor, imported_count,
                exported_count, source_count, reconciled_count, attempt,
                started_at, finished_at, error_summary, version
         FROM integration_syncs
         WHERE organization_id = ?
         ORDER BY started_at DESC LIMIT 25`,
      )
        .bind(context.organizationId)
        .all(),
      env.DB.prepare(
        `SELECT id, sync_id, external_record_type, external_record_id, code,
                message, retryable, status, created_at
         FROM integration_sync_errors
         WHERE organization_id = ? AND status = 'OPEN'
         ORDER BY created_at DESC LIMIT 25`,
      )
        .bind(context.organizationId)
        .all(),
    ]);

    return Response.json({
      data: {
        connections: connections.results,
        syncs: syncs.results,
        errors: errors.results,
        providerCapabilities: PROVIDER_CAPABILITIES,
        productionCredentialGate: {
          FIELDROUTES: "REQUIRES_VENDOR_ACCESS",
          PESTPAC: "REQUIRES_VENDOR_ACCESS",
          GORILLADESK: "REQUIRES_VENDOR_ACCESS",
        },
      },
      correlationId,
    });
  } catch {
    return unavailable(correlationId);
  }
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  try {
    const resolution = await getRequestContext(request, env.DB);
    if (!resolution.context) return contextDenied(resolution, correlationId);
    const context = resolution.context;
    const denied = authorizePermission(
      context,
      "INTEGRATION_MANAGE",
      correlationId,
    );
    if (denied) return denied;
    if (isCrossSiteMutation(request)) {
      return apiError(
        403,
        correlationId,
        "CROSS_SITE_WRITE_REJECTED",
        "Cross-site integration changes are not allowed.",
      );
    }
    if (
      request.headers.get("content-type")?.split(";", 1)[0].trim() !==
      "application/json"
    ) {
      return apiError(
        415,
        correlationId,
        "UNSUPPORTED_MEDIA_TYPE",
        "Integration commands require application/json.",
      );
    }
    const parsed = SyncRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return apiError(
        400,
        correlationId,
        "VALIDATION_ERROR",
        "The integration command was not valid.",
        parsed.error.flatten().fieldErrors,
      );
    }
    const command = parsed.data;
    if (request.headers.get("idempotency-key") !== command.idempotencyKey) {
      return apiError(
        400,
        correlationId,
        "IDEMPOTENCY_KEY_MISMATCH",
        "Idempotency-Key must match the request body.",
      );
    }
    const requestJson = JSON.stringify(command);
    const prior = await env.DB.prepare(
      `SELECT request_json, result_json
       FROM integration_syncs
       WHERE organization_id = ? AND idempotency_key = ?`,
    )
      .bind(context.organizationId, command.idempotencyKey)
      .first<PriorSync>();
    if (prior) {
      if (prior.request_json !== requestJson) {
        return apiError(
          409,
          correlationId,
          "IDEMPOTENCY_KEY_REUSED",
          "That idempotency key was already used for another sync request.",
        );
      }
      return Response.json({
        data: JSON.parse(prior.result_json),
        correlationId,
        idempotent: true,
      });
    }

    const persistedMappings = await loadJobMappings(context.organizationId);
    const relevantMappings = new Map(
      persistedMappings
        .filter((mapping) =>
          MOCK_JOB_ITEMS.some(
            (source) => source.externalId === mapping.external_id,
          ),
        )
        .map((mapping) => [mapping.external_id, mapping]),
    );
    for (const mapping of relevantMappings.values()) {
      if (mapping.internal_id !== internalJobId(mapping.external_id)) {
        throw new Error(
          `External mapping ${mapping.external_id} points to an unexpected job.`,
        );
      }
    }

    const adapter = new MockFSMAdapter(
      command.simulateFailure
        ? {
            failureRules: [
              {
                operation: "SYNC_BATCH",
                entityType: "JOB",
                matchKey: command.idempotencyKey,
                failuresBeforeSuccess: 1,
                retryable: true,
                code: "MOCK_UPSTREAM_TIMEOUT",
                message: "The mock FSM timed out before reconciliation.",
                retryAfterMs: 1000,
              },
            ],
          }
        : {},
    );
    adapter.hydrateEntityFingerprints(
      "JOB",
      Object.fromEntries(
        [...relevantMappings.values()].map((mapping) => [
          mapping.external_id,
          mapping.external_version ??
            `fieldproof:unknown-version:${mapping.external_id}`,
        ]),
      ),
    );
    const result = await adapter.syncBatch({
      idempotencyKey: command.idempotencyKey,
      entityType: "JOB",
      cursor: null,
      items: MOCK_JOB_ITEMS.map((item) => ({
        ...item,
        validationErrors: [...item.validationErrors],
      })),
    });
    const now = Date.now();
    const syncId = `SYNC-${crypto.randomUUID()}`;
    const status =
      result.status === "SUCCEEDED"
        ? "SUCCEEDED"
        : result.status === "PARTIAL"
          ? "PARTIAL"
          : "FAILED";
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO integration_syncs
          (id, organization_id, connection_id, direction, status, cursor,
           imported_count, exported_count, source_count, reconciled_count,
           attempt, request_json, result_json, started_at, finished_at,
           idempotency_key, error_summary, created_at, updated_at, version)
         VALUES (?, ?, ?, 'INBOUND', ?, ?, ?, 0, ?, ?, 1, ?, ?, ?, ?, ?, ?,
                 ?, ?, 1)`,
      ).bind(
        syncId,
        context.organizationId,
        PILOT_RECORDS.integrationConnectionId,
        status,
        result.cursor.token,
        result.totals.created + result.totals.updated,
        result.totals.received,
        result.totals.succeeded,
        requestJson,
        JSON.stringify(result),
        now,
        now,
        command.idempotencyKey,
        result.error?.message ?? null,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, organization_id, actor_type, actor_id, action, entity_type,
           entity_id, occurred_at, correlation_id, reason, policy_version,
           previous_json, next_json)
         VALUES (?, ?, 'HUMAN', ?, 'INTEGRATION_SYNC_COMPLETED',
                 'INTEGRATION_SYNC', ?, ?, ?, ?, 'integration-shadow-v1',
                 NULL, ?)`,
      ).bind(
        `AUD-${crypto.randomUUID()}`,
        context.organizationId,
        context.actorId,
        syncId,
        now,
        correlationId,
        `Mock shadow sync finished as ${status} with ${result.totals.succeeded}/${result.totals.received} reconciled.`,
        JSON.stringify(result),
      ),
    ];
    const requiredWrites: RequiredWrite[] = [
      { index: 0, label: "integration sync receipt" },
      { index: 1, label: "integration sync audit event" },
    ];
    for (const item of result.items) {
      if (item.status === "FAILED" || item.status === "QUARANTINED") {
        const index = statements.length;
        statements.push(
          env.DB.prepare(
            `INSERT INTO integration_sync_errors
              (id, organization_id, sync_id, external_record_type,
               external_record_id, code, message, retryable, status,
               created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, 1)`,
          ).bind(
            `SYNCERR-${crypto.randomUUID()}`,
            context.organizationId,
            syncId,
            item.entityType,
            item.externalId,
            item.reasonCode ?? item.error?.code ?? "QUARANTINED",
            item.message ?? item.error?.message ?? "Record requires review.",
            item.retryable ? 1 : 0,
            now,
            now,
          ),
        );
        requiredWrites.push({
          index,
          label: `integration error for item ${item.index}`,
        });
      }
      if (
        item.externalId &&
        item.fingerprint &&
        (item.status === "CREATED" || item.status === "UPDATED")
      ) {
        const index = statements.length;
        statements.push(
          env.DB.prepare(
            `INSERT INTO external_id_mappings
              (id, organization_id, connection_id, entity_type, internal_id,
               external_id, external_version, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT (
               organization_id, connection_id, entity_type, external_id
             ) DO UPDATE SET
               internal_id = excluded.internal_id,
               external_version = excluded.external_version,
               updated_at = excluded.updated_at,
               version = external_id_mappings.version + 1`,
          ).bind(
            `MAP-${crypto.randomUUID()}`,
            context.organizationId,
            PILOT_RECORDS.integrationConnectionId,
            item.entityType,
            internalJobId(item.externalId),
            item.externalId,
            item.fingerprint,
            now,
            now,
          ),
        );
        requiredWrites.push({
          index,
          label: `${item.status.toLowerCase()} mapping ${item.externalId}`,
        });
      }
    }
    if (status === "SUCCEEDED" || status === "PARTIAL") {
      const index = statements.length;
      statements.push(
        env.DB.prepare(
          `UPDATE integration_connections
           SET last_successful_sync_at = ?, updated_at = ?,
               version = version + 1
           WHERE organization_id = ? AND id = ?`,
        ).bind(
          now,
          now,
          context.organizationId,
          PILOT_RECORDS.integrationConnectionId,
        ),
      );
      requiredWrites.push({ index, label: "integration connection checkpoint" });
    }
    const writeResults = await env.DB.batch(statements);
    assertRequiredWrites(writeResults, requiredWrites);
    await assertPersistedMappings(context.organizationId, result.items);
    return Response.json(
      { data: result, correlationId, idempotent: false },
      { status: status === "FAILED" ? 502 : 201 },
    );
  } catch {
    return unavailable(correlationId);
  }
}

async function loadJobMappings(organizationId: string) {
  const result = await env.DB.prepare(
    `SELECT external_id, internal_id, external_version
     FROM external_id_mappings
     WHERE organization_id = ? AND connection_id = ? AND entity_type = 'JOB'`,
  )
    .bind(organizationId, PILOT_RECORDS.integrationConnectionId)
    .all<MappingRow>();
  return result.results;
}

async function assertPersistedMappings(
  organizationId: string,
  items: Array<{
    status: string;
    externalId: string | null;
    fingerprint: string | null;
  }>,
) {
  const expected = items.filter(
    (
      item,
    ): item is {
      status: string;
      externalId: string;
      fingerprint: string;
    } =>
      Boolean(item.externalId) &&
      Boolean(item.fingerprint) &&
      ["CREATED", "UPDATED", "SKIPPED"].includes(item.status),
  );
  if (expected.length === 0) return;

  const placeholders = expected.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT external_id, internal_id, external_version
     FROM external_id_mappings
     WHERE organization_id = ? AND connection_id = ? AND entity_type = 'JOB'
       AND external_id IN (${placeholders})`,
  )
    .bind(
      organizationId,
      PILOT_RECORDS.integrationConnectionId,
      ...expected.map((item) => item.externalId),
    )
    .all<MappingRow>();
  const persisted = new Map(
    result.results.map((mapping) => [mapping.external_id, mapping]),
  );
  for (const item of expected) {
    const mapping = persisted.get(item.externalId);
    if (
      !mapping ||
      mapping.internal_id !== internalJobId(item.externalId) ||
      mapping.external_version !== item.fingerprint
    ) {
      throw new Error(
        `External mapping ${item.externalId} did not match the reconciled result.`,
      );
    }
  }
}

function assertRequiredWrites(
  results: D1Result<unknown>[],
  requiredWrites: RequiredWrite[],
) {
  for (const required of requiredWrites) {
    if (Number(results[required.index]?.meta?.changes ?? 0) !== 1) {
      throw new Error(`Required ${required.label} write was not applied.`);
    }
  }
}

function internalJobId(externalId: string) {
  return externalId === "fsm-job-2048"
    ? PILOT_RECORDS.jobId
    : `SHADOW-${externalId}`;
}

function apiError(
  status: number,
  correlationId: string,
  code: string,
  message: string,
  fields?: unknown,
) {
  return Response.json(
    {
      error: {
        code,
        message,
        correlationId,
        ...(fields ? { fields } : {}),
      },
    },
    { status },
  );
}

function unavailable(correlationId: string) {
  return apiError(
    503,
    correlationId,
    "INTEGRATION_UNAVAILABLE",
    "Integration status is temporarily unavailable.",
  );
}
