import { env } from "cloudflare:workers";
import {
  getRequestContext,
  unauthorized,
} from "@/app/api/v1/request-context";

export async function GET(request: Request) {
  const correlationId = crypto.randomUUID();
  const context = getRequestContext(request);
  if (!context) return unauthorized(correlationId);

  try {
    const result = await env.DB.prepare(
      `SELECT id, actor_type, actor_id, action, entity_type, entity_id,
              occurred_at, correlation_id, reason, policy_version
       FROM audit_events
       WHERE organization_id = ?
       ORDER BY occurred_at DESC
       LIMIT 50`,
    )
      .bind(context.organizationId)
      .all();
    return Response.json({ data: result.results, correlationId });
  } catch {
    return unavailable(correlationId);
  }
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const context = getRequestContext(request);
  if (!context) return unauthorized(correlationId);

  return Response.json(
    {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message:
          "Audit events are emitted by authoritative workflow services.",
        correlationId,
      },
    },
    { status: 405, headers: { allow: "GET" } },
  );
}

function unavailable(correlationId: string) {
  return Response.json(
    {
      error: {
        code: "AUDIT_UNAVAILABLE",
        message: "The audit service is temporarily unavailable.",
        correlationId,
      },
    },
    { status: 503 },
  );
}
