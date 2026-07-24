import { env } from "cloudflare:workers";
import {
  contextDenied,
  getRequestContext,
} from "@/app/api/v1/request-context";

type CountRow = { count: number };
type SnapshotHealthRow = { version: number; updated_at: number };
type OldestPendingRow = { oldest: number | null };
type IntegrationHealthRow = {
  status: string;
  last_successful_sync_at: number | null;
};

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  const resolution = await getRequestContext(request, env.DB);
  if (!resolution.context) return contextDenied(resolution, correlationId);
  const context = resolution.context;

  try {
    const build = resolveBuildProvenance();
    const [
      pending,
      deadLetter,
      oldestPending,
      pendingOutcomes,
      overdueOutcomes,
      queuedDeliveries,
      failedDeliveries,
      delivered,
      integration,
      snapshot,
    ] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE organization_id = ? AND status IN ('PENDING', 'PROCESSING')`,
      )
        .bind(context.organizationId)
        .first<CountRow>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE organization_id = ? AND status = 'DEAD_LETTER'`,
      )
        .bind(context.organizationId)
        .first<CountRow>(),
      env.DB.prepare(
        `SELECT MIN(available_at) AS oldest FROM outbox_events
         WHERE organization_id = ? AND status = 'PENDING'`,
      )
        .bind(context.organizationId)
        .first<OldestPendingRow>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM outcome_checkpoints
         WHERE organization_id = ? AND status = 'PENDING'`,
      )
        .bind(context.organizationId)
        .first<CountRow>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM outcome_checkpoints
         WHERE organization_id = ? AND status = 'PENDING' AND due_at < ?`,
      )
        .bind(context.organizationId, Date.now())
        .first<CountRow>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM proof_deliveries
         WHERE organization_id = ?
           AND status IN ('QUEUED', 'SENDING', 'FAILED_RETRYABLE')`,
      )
        .bind(context.organizationId)
        .first<CountRow>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM proof_deliveries
         WHERE organization_id = ? AND status IN ('FAILED_FINAL', 'BOUNCED')`,
      )
        .bind(context.organizationId)
        .first<CountRow>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM proof_deliveries
         WHERE organization_id = ? AND status = 'DELIVERED'`,
      )
        .bind(context.organizationId)
        .first<CountRow>(),
      env.DB.prepare(
        `SELECT status, last_successful_sync_at
         FROM integration_connections
         WHERE organization_id = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
        .bind(context.organizationId)
        .first<IntegrationHealthRow>(),
      env.DB.prepare(
        "SELECT version, updated_at FROM workflow_snapshots WHERE organization_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
        .bind(context.organizationId)
        .first<SnapshotHealthRow>(),
    ]);

    const unverifiedProduction =
      process.env.NODE_ENV === "production" && !build.verified;
    return Response.json(
      {
        status: unverifiedProduction ? "degraded" : "ok",
        service: "fieldproof",
        version: "0.2.0",
        buildSha: build.sha,
        buildProvenance: build.verified ? "VERIFIED" : "UNVERIFIED",
        workflow: snapshot
          ? {
              status: "available",
              version: snapshot.version,
              updatedAt: new Date(snapshot.updated_at).toISOString(),
            }
          : { status: "not_initialized" },
        outbox: {
          dispatcher: "on_demand_mock_worker",
          pending: pending?.count ?? 0,
          deadLetter: deadLetter?.count ?? 0,
          oldestPendingAt: oldestPending?.oldest
            ? new Date(oldestPending.oldest).toISOString()
            : null,
        },
        outcomes: {
          pending: pendingOutcomes?.count ?? 0,
          overdue: overdueOutcomes?.count ?? 0,
        },
        proofDelivery: {
          queued: queuedDeliveries?.count ?? 0,
          delivered: delivered?.count ?? 0,
          failedFinal: failedDeliveries?.count ?? 0,
        },
        providers: {
          ai: "mock",
          integrations: {
            provider: "mock",
            status: integration?.status ?? "not_initialized",
            lastSuccessfulSyncAt: integration?.last_successful_sync_at
              ? new Date(
                  integration.last_successful_sync_at,
                ).toISOString()
              : null,
          },
        },
        ...(unverifiedProduction
          ? {
              error: {
                code: "BUILD_PROVENANCE_UNVERIFIED",
                message:
                  "Production was not built from a declared source commit.",
              },
            }
          : {}),
        correlationId,
        timestamp: new Date().toISOString(),
      },
      { status: unverifiedProduction ? 503 : 200 },
    );
  } catch {
    return Response.json(
      {
        status: "degraded",
        service: "fieldproof",
        error: {
          code: "HEALTH_DEPENDENCY_UNAVAILABLE",
          message: "The operational database could not be verified.",
          correlationId,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}

function resolveBuildProvenance() {
  const sha = [
    process.env.FIELDPROOF_BUILD_SHA,
    process.env.SOURCE_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.CF_PAGES_COMMIT_SHA,
  ].find(
    (value): value is string =>
      typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value),
  );
  return sha
    ? { sha, verified: true as const }
    : {
        sha:
          process.env.NODE_ENV === "production"
            ? "unverified"
            : "development",
        verified: false as const,
      };
}
