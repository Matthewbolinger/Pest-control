import { env } from "cloudflare:workers";
import { z } from "zod";

const AuditInput = z.object({
  actor: z.enum(["AI", "Human", "System"]),
  action: z.string().regex(/^[A-Z0-9_]{3,80}$/),
  reason: z.string().min(3).max(1000),
  policy: z.string().max(120).optional(),
  entityType: z.enum(["SERVICE_REQUEST", "JOB", "PROPERTY", "APPOINTMENT", "REPORT"]),
  entityId: z.string().regex(/^[A-Z0-9-]{3,80}$/),
});

export async function GET() {
  await ensureTables();
  const result = await env.DB.prepare(
    "SELECT id, actor_type, action, entity_type, entity_id, occurred_at, correlation_id, reason, policy_version FROM audit_events WHERE organization_id = ? ORDER BY occurred_at DESC LIMIT 50",
  ).bind("ORG-NORTHSTAR").all();
  return Response.json({ data: result.results, correlationId: crypto.randomUUID() });
}

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const parsed = AuditInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "The audit event was not valid.",
          correlationId,
          fields: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }
  await ensureTables();
  const id = `AUD-${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO audit_events (id, organization_id, actor_type, actor_id, action, entity_type, entity_id, occurred_at, correlation_id, reason, policy_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      "ORG-NORTHSTAR",
      parsed.data.actor.toUpperCase(),
      parsed.data.actor === "Human" ? "DEMO-AUTHENTICATED-USER" : parsed.data.actor,
      parsed.data.action,
      parsed.data.entityType,
      parsed.data.entityId,
      now,
      correlationId,
      parsed.data.reason,
      parsed.data.policy ?? null,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO outbox_events (id, organization_id, event_type, entity_id, payload_json, idempotency_key, status, attempts, available_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      `OUT-${crypto.randomUUID()}`,
      "ORG-NORTHSTAR",
      parsed.data.action,
      parsed.data.entityId,
      JSON.stringify(parsed.data),
      `${parsed.data.action}:${parsed.data.entityId}:${now}`,
      "PENDING",
      0,
      now,
      now,
      now,
      1,
    ),
  ]);
  return Response.json({ data: { id }, correlationId }, { status: 201 });
}

async function ensureTables() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      correlation_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      model_version TEXT,
      policy_version TEXT,
      previous_json TEXT,
      next_json TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS outbox_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    )`),
  ]);
}
