import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  MockCommunicationsAdapter,
  type CommunicationsAdapter,
  type IntegrationError,
} from "@/packages/integrations";
import { planProofDeliveryFailure } from "@/packages/application/proof-delivery";
import {
  WorkflowSnapshotSchema,
} from "@/packages/application/workflow";
import {
  authorizePermission,
  contextDenied,
  getRequestContext,
  isCrossSiteMutation,
  type RequestContext,
} from "@/app/api/v1/request-context";

const ProcessRequestSchema = z
  .object({
    action: z.literal("PROCESS_PENDING"),
    operationId: z
      .string()
      .trim()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9:._-]+$/),
    deliveryId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

type DeliveryRow = {
  id: string;
  organization_id: string;
  job_id: string;
  report_id: string;
  channel: string;
  recipient: string;
  status: string;
  idempotency_key: string;
  outbox_id: string;
  attempts: number;
};

type ReceiptRow = {
  request_json: string;
  response_json: string;
  status: string;
  applied_version: number | null;
  created_at: number;
};

type SnapshotRow = {
  id: string;
  snapshot_json: string;
  version: number;
};

const DELIVERY_CLAIM_LEASE_MS = 2 * 60 * 1000;

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  try {
    const resolution = await getRequestContext(request, env.DB);
    if (!resolution.context) return contextDenied(resolution, correlationId);
    const denied = authorizePermission(
      resolution.context,
      "PROOF_SEND",
      correlationId,
    );
    if (denied) return denied;

    const [deliveries, outbox] = await Promise.all([
      env.DB.prepare(
        `SELECT id, job_id, report_id, channel, recipient, status,
                provider_message_id, failure_reason, queued_at, delivered_at,
                updated_at, version
         FROM proof_deliveries
         WHERE organization_id = ?
         ORDER BY queued_at DESC LIMIT 25`,
      )
        .bind(resolution.context.organizationId)
        .all(),
      env.DB.prepare(
        `SELECT id, event_type, entity_id, status, attempts, available_at,
                last_error, processed_at, updated_at
         FROM outbox_events
         WHERE organization_id = ?
         ORDER BY created_at DESC LIMIT 50`,
      )
        .bind(resolution.context.organizationId)
        .all(),
    ]);

    return Response.json({
      data: {
        deliveries: deliveries.results,
        outbox: outbox.results,
        counts: countStatuses(
          deliveries.results as Array<{ status?: unknown }>,
          outbox.results as Array<{ status?: unknown }>,
        ),
      },
      correlationId,
    });
  } catch {
    return unavailable(correlationId);
  }
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  let context: RequestContext;
  try {
    const resolution = await getRequestContext(request, env.DB);
    if (!resolution.context) return contextDenied(resolution, correlationId);
    context = resolution.context;
  } catch {
    return unavailable(correlationId);
  }
  if (isCrossSiteMutation(request)) {
    return errorResponse(
      403,
      "CROSS_SITE_WRITE_REJECTED",
      "Cross-site outbox processing is not allowed.",
      correlationId,
    );
  }
  const denied = authorizePermission(context, "PROOF_SEND", correlationId);
  if (denied) return denied;
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim() !==
    "application/json"
  ) {
    return errorResponse(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Outbox operations require application/json.",
      correlationId,
    );
  }

  const parsed = ProcessRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return errorResponse(
      400,
      "VALIDATION_ERROR",
      "The outbox operation was not valid.",
      correlationId,
    );
  }
  const command = parsed.data;
  if (request.headers.get("idempotency-key") !== command.operationId) {
    return errorResponse(
      400,
      "IDEMPOTENCY_KEY_MISMATCH",
      "Idempotency-Key must match operationId.",
      correlationId,
    );
  }
  const requestJson = JSON.stringify(command);

  try {
    const now = Date.now();
    await recoverStaleClaims(context.organizationId, now);
    const reservation = await reserveReceipt({
      context,
      operationId: command.operationId,
      requestJson,
      now,
    });
    if (!reservation.owned) {
      const prior = reservation.receipt;
      if (prior.request_json !== requestJson) {
        return errorResponse(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "That operationId was already used for another request.",
          correlationId,
        );
      }
      if (prior.status === "PROCESSING") {
        return errorResponse(
          409,
          "OPERATION_IN_PROGRESS",
          "That delivery operation is already in progress. Retry with the same operationId.",
          correlationId,
        );
      }
      const cached = JSON.parse(prior.response_json) as {
        status?: string;
      };
      return Response.json(
        {
          data: cached,
          correlationId,
          idempotent: true,
        },
        {
          status:
            prior.status === "FAILED"
              ? cached.status === "FAILED_RETRYABLE"
                ? 503
                : 422
              : 200,
        },
      );
    }

    const reservedDeliveryId = processingDeliveryId(reservation.receipt);
    const recovered = await recoverReservedDeliveryResult({
      context,
      command,
      requestJson,
      receipt: reservation.receipt,
      correlationId,
      now,
    });
    if (recovered) return recovered;

    const delivery = await findPendingDelivery(
      context.organizationId,
      command.deliveryId ?? reservedDeliveryId,
      now,
    );
    if (!delivery) {
      const response = { status: "IDLE", processed: 0 };
      await finalizeReservedReceipt({
        context,
        operationId: command.operationId,
        requestJson,
        reservedAt: reservation.receipt.created_at,
        response,
        status: "SUCCEEDED",
        appliedVersion: null,
        now,
      });
      return Response.json({
        data: response,
        correlationId,
        idempotent: false,
      });
    }

    const claim = await env.DB.batch([
      env.DB.prepare(
        `UPDATE proof_deliveries
         SET status = 'SENDING', failure_reason = NULL, updated_at = ?,
             version = version + 1
         WHERE id = ? AND organization_id = ?
           AND status IN ('QUEUED', 'FAILED_RETRYABLE')`,
      ).bind(now, delivery.id, context.organizationId),
      env.DB.prepare(
        `UPDATE outbox_events
         SET status = 'PROCESSING', updated_at = ?, version = version + 1
         WHERE id = ? AND organization_id = ? AND status = 'PENDING'
           AND available_at <= ?`,
      ).bind(
        now,
        delivery.outbox_id,
        context.organizationId,
        now,
      ),
      env.DB.prepare(
        `UPDATE sync_operation_receipts
         SET response_json = ?
         WHERE organization_id = ? AND operation_id = ?
           AND request_json = ? AND status = 'PROCESSING'
           AND created_at = ?`,
      ).bind(
        JSON.stringify({
          status: "PROCESSING",
          processed: 0,
          deliveryId: delivery.id,
          reportId: delivery.report_id,
        }),
        context.organizationId,
        command.operationId,
        requestJson,
        reservation.receipt.created_at,
      ),
    ]);
    if (
      Number(claim[0]?.meta?.changes ?? 0) !== 1 ||
      Number(claim[1]?.meta?.changes ?? 0) !== 1 ||
      Number(claim[2]?.meta?.changes ?? 0) !== 1
    ) {
      await releasePartialClaim(context.organizationId, delivery, now);
      await releaseReceiptReservation(
        context.organizationId,
        command.operationId,
        requestJson,
        reservation.receipt.created_at,
      );
      return errorResponse(
        409,
        "DELIVERY_ALREADY_CLAIMED",
        "The delivery is already being processed. Refresh its status.",
        correlationId,
      );
    }

    const adapter: CommunicationsAdapter = new MockCommunicationsAdapter();
    let adapterResult;
    try {
      adapterResult = await adapter.sendServiceProof(
        delivery.idempotency_key,
        delivery.recipient,
        delivery.report_id,
      );
    } catch (error) {
      throw new DeliveryProcessingError(
        delivery,
        now,
        reservation.receipt.created_at,
        {
          code: "DELIVERY_PROVIDER_UNAVAILABLE",
          message:
            error instanceof Error
              ? error.message
              : "The communications adapter was unavailable.",
          retryable: true,
          retryAfterMs: null,
        },
      );
    }
    if (
      adapterResult.status !== "SUCCEEDED" ||
      !adapterResult.data?.messageId
    ) {
      const adapterError =
        adapterResult.errorDetails ??
        ({
          code: "DELIVERY_PROVIDER_REJECTED",
          message:
            adapterResult.error ??
            "The communications adapter rejected the delivery.",
          retryable: false,
          retryAfterMs: null,
        } satisfies IntegrationError);
      return persistFailure({
        context,
        command,
        requestJson,
        delivery,
        claimedAt: now,
        reservedAt: reservation.receipt.created_at,
        error: adapterError,
        now: Date.now(),
        correlationId,
      });
    }

    const deliveredAt = Date.now();
    const response = {
      status: "DELIVERED",
      processed: 1,
      deliveryId: delivery.id,
      reportId: delivery.report_id,
      provider: "MOCK",
      providerMessageId: adapterResult.data.messageId,
      deliveredAt: new Date(deliveredAt).toISOString(),
    };
    const finalized = await env.DB.batch([
      env.DB.prepare(
        `UPDATE proof_deliveries
         SET status = 'DELIVERED', provider_message_id = ?,
             failure_reason = NULL, delivered_at = ?, updated_at = ?,
             version = version + 1
         WHERE id = ? AND organization_id = ? AND status = 'SENDING'
           AND updated_at = ?
           AND EXISTS (
             SELECT 1 FROM sync_operation_receipts
             WHERE organization_id = ? AND operation_id = ?
               AND request_json = ? AND status = 'PROCESSING'
               AND created_at = ?
           )`,
      ).bind(
        adapterResult.data.messageId,
        deliveredAt,
        deliveredAt,
        delivery.id,
        context.organizationId,
        now,
        context.organizationId,
        command.operationId,
        requestJson,
        reservation.receipt.created_at,
      ),
      env.DB.prepare(
        `UPDATE outbox_events
         SET status = 'PROCESSED', attempts = attempts + 1,
             last_error = NULL, processed_at = ?, updated_at = ?,
             version = version + 1
         WHERE id = ? AND organization_id = ? AND status = 'PROCESSING'
           AND updated_at = ?
           AND EXISTS (
             SELECT 1 FROM sync_operation_receipts
             WHERE organization_id = ? AND operation_id = ?
               AND request_json = ? AND status = 'PROCESSING'
               AND created_at = ?
           )`,
      ).bind(
        deliveredAt,
        deliveredAt,
        delivery.outbox_id,
        context.organizationId,
        now,
        context.organizationId,
        command.operationId,
        requestJson,
        reservation.receipt.created_at,
      ),
      env.DB.prepare(
        `SELECT CASE WHEN
           EXISTS (
             SELECT 1 FROM sync_operation_receipts
             WHERE organization_id = ? AND operation_id = ?
               AND request_json = ? AND status = 'PROCESSING'
               AND created_at = ?
           )
           AND EXISTS (
             SELECT 1 FROM proof_deliveries
             WHERE id = ? AND organization_id = ? AND status = 'DELIVERED'
               AND provider_message_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM outbox_events
             WHERE id = ? AND organization_id = ? AND status = 'PROCESSED'
           )
         THEN 1 ELSE json('FIELDPROOF_DELIVERY_STATE_FINALIZATION_FAILED') END`,
      ).bind(
        context.organizationId,
        command.operationId,
        requestJson,
        reservation.receipt.created_at,
        delivery.id,
        context.organizationId,
        adapterResult.data.messageId,
        delivery.outbox_id,
        context.organizationId,
      ),
    ]);
    if (
      Number(finalized[0]?.meta?.changes ?? 0) !== 1 ||
      Number(finalized[1]?.meta?.changes ?? 0) !== 1
    ) {
      throw new Error("The delivery claim was lost before finalization.");
    }
    const durable = await readConfirmedDelivery(
      context.organizationId,
      delivery.id,
      delivery.outbox_id,
    );
    if (
      !durable ||
      durable.delivery_status !== "DELIVERED" ||
      durable.outbox_status !== "PROCESSED" ||
      durable.provider_message_id !== adapterResult.data.messageId
    ) {
      throw new Error("Confirmed delivery state did not converge.");
    }

    const appliedVersion = await reconcileDeliveredSnapshot(
      context.organizationId,
      delivery,
      command.operationId,
      deliveredAt,
    );
    await finalizeSuccessfulReceipt({
      context,
      operationId: command.operationId,
      requestJson,
      response,
      appliedVersion,
      reservedAt: reservation.receipt.created_at,
      delivery,
      correlationId,
      now: deliveredAt,
    });
    return Response.json({
      data: response,
      correlationId,
      idempotent: false,
    });
  } catch (error) {
    if (error instanceof DeliveryProcessingError) {
      return persistFailure({
        context,
        command,
        requestJson,
        delivery: error.delivery,
        claimedAt: error.claimedAt,
        reservedAt: error.reservedAt,
        error: error.integrationError,
        now: Date.now(),
        correlationId,
      });
    }
    return unavailable(correlationId);
  }
}

async function reserveReceipt(input: {
  context: RequestContext;
  operationId: string;
  requestJson: string;
  now: number;
}): Promise<
  | { owned: true; receipt: ReceiptRow }
  | { owned: false; receipt: ReceiptRow }
> {
  const processingResponse = JSON.stringify({
    status: "PROCESSING",
    processed: 0,
  });
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO sync_operation_receipts
      (id, organization_id, workflow_id, operation_id, operation_type,
       request_json, response_json, status, applied_version, created_at)
     VALUES (?, ?, ?, ?, 'PROOF_DELIVERY', ?, ?, 'PROCESSING', NULL, ?)`,
  )
    .bind(
      `SOR-${crypto.randomUUID()}`,
      input.context.organizationId,
      "WF-JOB-2048",
      input.operationId,
      input.requestJson,
      processingResponse,
      input.now,
    )
    .run();
  if (Number(inserted.meta?.changes ?? 0) === 1) {
    return {
      owned: true,
      receipt: {
        request_json: input.requestJson,
        response_json: processingResponse,
        status: "PROCESSING",
        applied_version: null,
        created_at: input.now,
      },
    };
  }

  const prior = await findReceipt(
    input.context.organizationId,
    input.operationId,
  );
  if (!prior) throw new Error("The delivery reservation was not available.");
  if (
    prior.request_json === input.requestJson &&
    prior.status === "PROCESSING" &&
    prior.created_at < input.now - DELIVERY_CLAIM_LEASE_MS
  ) {
    const reclaimedAt = Math.max(input.now, prior.created_at + 1);
    const reclaimed = await env.DB.prepare(
      `UPDATE sync_operation_receipts
       SET created_at = ?
       WHERE organization_id = ? AND operation_id = ?
         AND request_json = ? AND status = 'PROCESSING'
         AND created_at = ?`,
    )
      .bind(
        reclaimedAt,
        input.context.organizationId,
        input.operationId,
        input.requestJson,
        prior.created_at,
      )
      .run();
    if (Number(reclaimed.meta?.changes ?? 0) === 1) {
      return {
        owned: true,
        receipt: { ...prior, created_at: reclaimedAt },
      };
    }
    const raced = await findReceipt(
      input.context.organizationId,
      input.operationId,
    );
    if (!raced) {
      throw new Error("The delivery reservation changed unexpectedly.");
    }
    return { owned: false, receipt: raced };
  }
  return { owned: false, receipt: prior };
}

function processingDeliveryId(receipt: ReceiptRow) {
  if (receipt.status !== "PROCESSING") return null;
  try {
    const value = JSON.parse(receipt.response_json) as {
      deliveryId?: unknown;
    };
    return typeof value.deliveryId === "string" ? value.deliveryId : null;
  } catch {
    return null;
  }
}

async function recoverReservedDeliveryResult(input: {
  context: RequestContext;
  command: z.infer<typeof ProcessRequestSchema>;
  requestJson: string;
  receipt: ReceiptRow;
  correlationId: string;
  now: number;
}) {
  const deliveryId = processingDeliveryId(input.receipt);
  if (!deliveryId) return null;
  const row = await env.DB.prepare(
    `SELECT pd.id, pd.organization_id, pd.job_id, pd.report_id, pd.channel,
            pd.recipient, pd.status AS delivery_status,
            pd.provider_message_id, pd.delivered_at, pd.idempotency_key,
            oe.id AS outbox_id, oe.status AS outbox_status, oe.attempts
     FROM proof_deliveries pd
     JOIN outbox_events oe
       ON oe.organization_id = pd.organization_id
      AND oe.entity_id = pd.report_id
      AND oe.event_type = 'SERVICE_PROOF_DELIVERY_QUEUED'
      AND json_extract(oe.payload_json, '$.commandId') = pd.idempotency_key
     WHERE pd.organization_id = ? AND pd.id = ?
     LIMIT 1`,
  )
    .bind(input.context.organizationId, deliveryId)
    .first<{
      id: string;
      organization_id: string;
      job_id: string;
      report_id: string;
      channel: string;
      recipient: string;
      delivery_status: string;
      provider_message_id: string | null;
      delivered_at: number | null;
      idempotency_key: string;
      outbox_id: string;
      outbox_status: string;
      attempts: number;
    }>();
  if (
    !row ||
    row.delivery_status !== "DELIVERED" ||
    row.outbox_status !== "PROCESSED" ||
    !row.provider_message_id ||
    row.delivered_at === null
  ) {
    return null;
  }

  const delivery: DeliveryRow = {
    id: row.id,
    organization_id: row.organization_id,
    job_id: row.job_id,
    report_id: row.report_id,
    channel: row.channel,
    recipient: row.recipient,
    status: row.delivery_status,
    idempotency_key: row.idempotency_key,
    outbox_id: row.outbox_id,
    attempts: row.attempts,
  };
  const response = {
    status: "DELIVERED",
    processed: 1,
    deliveryId: row.id,
    reportId: row.report_id,
    provider: "MOCK",
    providerMessageId: row.provider_message_id,
    deliveredAt: new Date(row.delivered_at).toISOString(),
  };
  const appliedVersion = await reconcileDeliveredSnapshot(
    input.context.organizationId,
    delivery,
    input.command.operationId,
    row.delivered_at,
  );
  await finalizeSuccessfulReceipt({
    context: input.context,
    operationId: input.command.operationId,
    requestJson: input.requestJson,
    response,
    appliedVersion,
    reservedAt: input.receipt.created_at,
    delivery,
    correlationId: input.correlationId,
    now: input.now,
  });
  return Response.json({
    data: response,
    correlationId: input.correlationId,
    idempotent: true,
  });
}

async function releaseReceiptReservation(
  organizationId: string,
  operationId: string,
  requestJson: string,
  reservedAt: number,
) {
  await env.DB.prepare(
    `DELETE FROM sync_operation_receipts
     WHERE organization_id = ? AND operation_id = ?
       AND request_json = ? AND status = 'PROCESSING'
       AND created_at = ?`,
  )
    .bind(organizationId, operationId, requestJson, reservedAt)
    .run();
}

async function finalizeReservedReceipt(input: {
  context: RequestContext;
  operationId: string;
  requestJson: string;
  reservedAt: number;
  response: unknown;
  status: string;
  appliedVersion: number | null;
  now: number;
}) {
  const updated = await env.DB.prepare(
    `UPDATE sync_operation_receipts
     SET response_json = ?, status = ?, applied_version = ?
     WHERE organization_id = ? AND operation_id = ?
       AND request_json = ? AND status = 'PROCESSING'
       AND created_at = ?`,
  )
    .bind(
      JSON.stringify(input.response),
      input.status,
      input.appliedVersion,
      input.context.organizationId,
      input.operationId,
      input.requestJson,
      input.reservedAt,
    )
    .run();
  if (Number(updated.meta?.changes ?? 0) !== 1) {
    throw new Error("The delivery operation reservation was lost.");
  }
}

async function readConfirmedDelivery(
  organizationId: string,
  deliveryId: string,
  outboxId: string,
) {
  return env.DB.prepare(
    `SELECT pd.status AS delivery_status, pd.provider_message_id,
            oe.status AS outbox_status
     FROM proof_deliveries pd
     JOIN outbox_events oe
       ON oe.id = ? AND oe.organization_id = pd.organization_id
     WHERE pd.id = ? AND pd.organization_id = ?
     LIMIT 1`,
  )
    .bind(outboxId, deliveryId, organizationId)
    .first<{
      delivery_status: string;
      provider_message_id: string | null;
      outbox_status: string;
    }>();
}

async function finalizeSuccessfulReceipt(input: {
  context: RequestContext;
  operationId: string;
  requestJson: string;
  response: unknown;
  appliedVersion: number;
  reservedAt: number;
  delivery: DeliveryRow;
  correlationId: string;
  now: number;
}) {
  const responseJson = JSON.stringify(input.response);
  const auditId = `AUD-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE sync_operation_receipts
       SET response_json = ?, status = 'SUCCEEDED', applied_version = ?
       WHERE organization_id = ? AND operation_id = ?
         AND request_json = ? AND status = 'PROCESSING'
         AND created_at = ?`,
    ).bind(
      responseJson,
      input.appliedVersion,
      input.context.organizationId,
      input.operationId,
      input.requestJson,
      input.reservedAt,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, organization_id, actor_type, actor_id, action, entity_type,
         entity_id, occurred_at, correlation_id, reason, model_version,
         policy_version, previous_json, next_json)
       SELECT ?, ?, 'SYSTEM', ?, 'SERVICE_PROOF_DELIVERED', 'REPORT', ?,
              ?, ?, ?, NULL, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM sync_operation_receipts
         WHERE organization_id = ? AND operation_id = ?
           AND request_json = ? AND response_json = ?
           AND status = 'SUCCEEDED' AND created_at = ?
       )`,
    ).bind(
      auditId,
      input.context.organizationId,
      input.context.actorId,
      input.delivery.report_id,
      input.now,
      input.correlationId,
      "The mock communications adapter confirmed delivery with a provider message identifier.",
      "proof-delivery-v1",
      JSON.stringify({
        deliveryStatus: input.delivery.status,
        outboxStatus: "PROCESSING",
      }),
      responseJson,
      input.context.organizationId,
      input.operationId,
      input.requestJson,
      responseJson,
      input.reservedAt,
    ),
    env.DB.prepare(
      `SELECT CASE WHEN
         EXISTS (
           SELECT 1 FROM sync_operation_receipts
           WHERE organization_id = ? AND operation_id = ?
             AND request_json = ? AND response_json = ?
             AND status = 'SUCCEEDED' AND created_at = ?
         )
         AND EXISTS (
           SELECT 1 FROM audit_events
           WHERE id = ? AND organization_id = ?
         )
       THEN 1 ELSE json('FIELDPROOF_DELIVERY_FINALIZATION_FAILED') END`,
    ).bind(
      input.context.organizationId,
      input.operationId,
      input.requestJson,
      responseJson,
      input.reservedAt,
      auditId,
      input.context.organizationId,
    ),
  ]);
}

async function recoverStaleClaims(organizationId: string, now: number) {
  const staleBefore = now - DELIVERY_CLAIM_LEASE_MS;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE proof_deliveries
       SET status = 'FAILED_RETRYABLE',
           failure_reason = 'The prior delivery claim expired; retrying with the same provider idempotency key.',
           updated_at = ?, version = version + 1
       WHERE organization_id = ? AND status = 'SENDING'
         AND updated_at < ?`,
    ).bind(now, organizationId, staleBefore),
    env.DB.prepare(
      `UPDATE outbox_events
       SET status = 'PENDING', available_at = ?, last_error =
             'The prior delivery claim expired before confirmation.',
           updated_at = ?, version = version + 1
       WHERE organization_id = ? AND status = 'PROCESSING'
         AND event_type = 'SERVICE_PROOF_DELIVERY_QUEUED'
         AND updated_at < ?`,
    ).bind(now, now, organizationId, staleBefore),
  ]);
}

async function releasePartialClaim(
  organizationId: string,
  delivery: DeliveryRow,
  claimedAt: number,
) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE proof_deliveries
       SET status = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND organization_id = ? AND status = 'SENDING'
         AND updated_at = ?`,
    ).bind(
      delivery.status,
      claimedAt,
      delivery.id,
      organizationId,
      claimedAt,
    ),
    env.DB.prepare(
      `UPDATE outbox_events
       SET status = 'PENDING', updated_at = ?, version = version + 1
       WHERE id = ? AND organization_id = ? AND status = 'PROCESSING'
         AND updated_at = ?`,
    ).bind(
      claimedAt,
      delivery.outbox_id,
      organizationId,
      claimedAt,
    ),
  ]);
}

async function findPendingDelivery(
  organizationId: string,
  deliveryId: string | null,
  now: number,
) {
  return env.DB.prepare(
    `SELECT pd.id, pd.organization_id, pd.job_id, pd.report_id, pd.channel,
            pd.recipient, pd.status, pd.idempotency_key,
            oe.id AS outbox_id, oe.attempts
     FROM proof_deliveries pd
     JOIN outbox_events oe
       ON oe.organization_id = pd.organization_id
      AND oe.entity_id = pd.report_id
      AND oe.event_type = 'SERVICE_PROOF_DELIVERY_QUEUED'
      AND json_extract(oe.payload_json, '$.commandId') = pd.idempotency_key
     WHERE pd.organization_id = ?
       AND pd.status IN ('QUEUED', 'FAILED_RETRYABLE')
       AND oe.status = 'PENDING' AND oe.available_at <= ?
       AND (? IS NULL OR pd.id = ?)
     ORDER BY pd.queued_at ASC LIMIT 1`,
  )
    .bind(organizationId, now, deliveryId, deliveryId)
    .first<DeliveryRow>();
}

async function findReceipt(organizationId: string, operationId: string) {
  return env.DB.prepare(
    `SELECT request_json, response_json, status, applied_version, created_at
     FROM sync_operation_receipts
     WHERE organization_id = ? AND operation_id = ?`,
  )
    .bind(organizationId, operationId)
    .first<ReceiptRow>();
}

async function projectDeliveredSnapshot(
  organizationId: string,
  delivery: DeliveryRow,
  operationId: string,
  now: number,
) {
  const row = await env.DB.prepare(
    `SELECT id, snapshot_json, version
     FROM workflow_snapshots
     WHERE organization_id = ? AND job_id = ? LIMIT 1`,
  )
    .bind(organizationId, delivery.job_id)
    .first<SnapshotRow>();
  if (!row) return null;
  const current = WorkflowSnapshotSchema.parse(JSON.parse(row.snapshot_json));
  if (current.proofId !== delivery.report_id) return null;
  const projectedAt = Math.max(
    now,
    new Date(current.updatedAt).getTime(),
  );
  const next = WorkflowSnapshotSchema.parse({
    ...current,
    version: current.version + 1,
    lastCommandId: `DELIVERY:${operationId}`,
    proofDeliveryStatus: "DELIVERED",
    proofSent: true,
    updatedAt: new Date(projectedAt).toISOString(),
  });
  return { row, current, next };
}

async function reconcileDeliveredSnapshot(
  organizationId: string,
  delivery: DeliveryRow,
  operationId: string,
  deliveredAt: number,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const projection = await projectDeliveredSnapshot(
      organizationId,
      delivery,
      operationId,
      deliveredAt,
    );
    if (!projection) {
      throw new Error(
        "The delivered proof no longer matches the authoritative workflow snapshot.",
      );
    }
    if (
      projection.current.proofDeliveryStatus === "DELIVERED" &&
      projection.current.proofSent
    ) {
      return projection.current.version;
    }
    const updated = await env.DB.prepare(
      `UPDATE workflow_snapshots
       SET snapshot_json = ?, last_command_id = ?, updated_at = ?,
           version = ?
       WHERE id = ? AND organization_id = ? AND version = ?`,
    )
      .bind(
        JSON.stringify(projection.next),
        `DELIVERY:${operationId}`,
        new Date(projection.next.updatedAt).getTime(),
        projection.next.version,
        projection.row.id,
        organizationId,
        projection.row.version,
      )
      .run();
    if (Number(updated.meta?.changes ?? 0) === 1) {
      return projection.next.version;
    }
  }
  throw new Error(
    "The delivered proof snapshot did not converge before finalization.",
  );
}

async function persistFailure(input: {
  context: RequestContext;
  command: z.infer<typeof ProcessRequestSchema>;
  requestJson: string;
  delivery: DeliveryRow;
  claimedAt: number;
  reservedAt: number;
  error: IntegrationError;
  now: number;
  correlationId: string;
}) {
  const plan = planProofDeliveryFailure({
    currentAttempts: input.delivery.attempts,
    error: input.error,
    nowMs: input.now,
  });
  const response = {
    status: plan.deliveryStatus,
    processed: 0,
    deliveryId: input.delivery.id,
    reportId: input.delivery.report_id,
    retryAt:
      plan.outboxStatus === "PENDING"
        ? new Date(plan.availableAt).toISOString()
        : null,
    failureReason: plan.failureReason,
  };
  const responseJson = JSON.stringify(response);
  const auditId = `AUD-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE proof_deliveries
       SET status = ?, failure_reason = ?, updated_at = ?,
           version = version + 1
       WHERE id = ? AND organization_id = ? AND status = 'SENDING'
         AND updated_at = ?`,
    ).bind(
      plan.deliveryStatus,
      plan.failureReason,
      input.now,
      input.delivery.id,
      input.context.organizationId,
      input.claimedAt,
    ),
    env.DB.prepare(
      `UPDATE outbox_events
       SET status = ?, attempts = ?, available_at = ?, last_error = ?,
           processed_at = NULL, updated_at = ?, version = version + 1
       WHERE id = ? AND organization_id = ? AND status = 'PROCESSING'
         AND updated_at = ?`,
    ).bind(
      plan.outboxStatus,
      plan.attempt,
      plan.availableAt,
      plan.failureReason,
      input.now,
      input.delivery.outbox_id,
      input.context.organizationId,
      input.claimedAt,
    ),
    env.DB.prepare(
      `UPDATE sync_operation_receipts
       SET response_json = ?, status = 'FAILED', applied_version = NULL
       WHERE organization_id = ? AND operation_id = ?
         AND request_json = ? AND status = 'PROCESSING'
         AND created_at = ?
         AND EXISTS (
           SELECT 1 FROM proof_deliveries
           WHERE id = ? AND organization_id = ? AND status = ?
         )
         AND EXISTS (
           SELECT 1 FROM outbox_events
           WHERE id = ? AND organization_id = ? AND status = ?
         )`,
    ).bind(
      responseJson,
      input.context.organizationId,
      input.command.operationId,
      input.requestJson,
      input.reservedAt,
      input.delivery.id,
      input.context.organizationId,
      plan.deliveryStatus,
      input.delivery.outbox_id,
      input.context.organizationId,
      plan.outboxStatus,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, organization_id, actor_type, actor_id, action, entity_type,
         entity_id, occurred_at, correlation_id, reason, model_version,
         policy_version, previous_json, next_json)
       SELECT ?, ?, 'SYSTEM', ?, ?, 'REPORT', ?, ?, ?, ?, NULL, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM sync_operation_receipts
         WHERE organization_id = ? AND operation_id = ?
           AND request_json = ? AND response_json = ? AND status = 'FAILED'
           AND created_at = ?
       )`,
    ).bind(
      auditId,
      input.context.organizationId,
      input.context.actorId,
      plan.outboxStatus === "PENDING"
        ? "SERVICE_PROOF_DELIVERY_RETRY_SCHEDULED"
        : "SERVICE_PROOF_DELIVERY_DEAD_LETTERED",
      input.delivery.report_id,
      input.now,
      input.correlationId,
      plan.failureReason,
      "proof-delivery-v1",
      JSON.stringify({ status: "SENDING" }),
      responseJson,
      input.context.organizationId,
      input.command.operationId,
      input.requestJson,
      responseJson,
      input.reservedAt,
    ),
    env.DB.prepare(
      `SELECT CASE WHEN
         EXISTS (
           SELECT 1 FROM sync_operation_receipts
           WHERE organization_id = ? AND operation_id = ?
             AND request_json = ? AND response_json = ? AND status = 'FAILED'
             AND created_at = ?
         )
         AND EXISTS (
           SELECT 1 FROM audit_events
           WHERE id = ? AND organization_id = ?
         )
       THEN 1 ELSE json('FIELDPROOF_DELIVERY_FAILURE_FINALIZATION_FAILED') END`,
    ).bind(
      input.context.organizationId,
      input.command.operationId,
      input.requestJson,
      responseJson,
      input.reservedAt,
      auditId,
      input.context.organizationId,
    ),
  ]);
  return Response.json(
    { data: response, correlationId: input.correlationId, idempotent: false },
    { status: plan.outboxStatus === "PENDING" ? 503 : 422 },
  );
}

function countStatuses(
  deliveries: Array<{ status?: unknown }>,
  outbox: Array<{ status?: unknown }>,
) {
  const count = (
    rows: Array<{ status?: unknown }>,
    statuses: readonly string[],
  ) => rows.filter((row) => statuses.includes(String(row.status))).length;
  return {
    queuedDeliveries: count(deliveries, ["QUEUED", "FAILED_RETRYABLE"]),
    delivered: count(deliveries, ["DELIVERED"]),
    failedFinal: count(deliveries, ["FAILED_FINAL", "BOUNCED"]),
    pendingOutbox: count(outbox, ["PENDING", "PROCESSING"]),
    deadLetter: count(outbox, ["DEAD_LETTER"]),
  };
}

class DeliveryProcessingError extends Error {
  constructor(
    readonly delivery: DeliveryRow,
    readonly claimedAt: number,
    readonly reservedAt: number,
    readonly integrationError: IntegrationError,
  ) {
    super(integrationError.message);
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  correlationId: string,
) {
  return Response.json(
    { error: { code, message, correlationId } },
    { status },
  );
}

function unavailable(correlationId: string) {
  return errorResponse(
    503,
    "OUTBOX_UNAVAILABLE",
    "Proof delivery processing is temporarily unavailable.",
    correlationId,
  );
}
