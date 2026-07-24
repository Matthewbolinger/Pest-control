import { env } from "cloudflare:workers";
import {
  getRequestContext,
  unauthorized,
} from "@/app/api/v1/request-context";

type CountRow = { count: number };
type SnapshotHealthRow = { version: number; updated_at: number };

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  const context = getRequestContext(request);
  if (!context) return unauthorized(correlationId);

  try {
    const [pending, failed, snapshot] = await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM outbox_events WHERE organization_id = ? AND status = 'PENDING'",
      )
        .bind(context.organizationId)
        .first<CountRow>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM outbox_events WHERE organization_id = ? AND status = 'FAILED'",
      )
        .bind(context.organizationId)
        .first<CountRow>(),
      env.DB.prepare(
        "SELECT version, updated_at FROM workflow_snapshots WHERE organization_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
        .bind(context.organizationId)
        .first<SnapshotHealthRow>(),
    ]);

    return Response.json({
      status: "ok",
      service: "fieldproof",
      version: "0.1.0",
      workflow: snapshot
        ? {
            status: "available",
            version: snapshot.version,
            updatedAt: new Date(snapshot.updated_at).toISOString(),
          }
        : { status: "not_initialized" },
      outbox: {
        dispatcher: "not_configured",
        pending: pending?.count ?? 0,
        failed: failed?.count ?? 0,
      },
      providers: {
        ai: "mock",
        integrations: "mock",
      },
      correlationId,
      timestamp: new Date().toISOString(),
    });
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
