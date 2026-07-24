import { env } from "cloudflare:workers";
import { z } from "zod";

const Metadata = z.object({
  jobId: z.string().regex(/^JOB-[A-Z0-9-]+$/),
  propertyId: z.string().regex(/^PROP-[A-Z0-9-]+$/),
  zoneId: z.string().regex(/^ZONE-[A-Z0-9-]+$/),
});

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maximumBytes = 10 * 1024 * 1024;

export async function POST(request: Request) {
  const correlationId = crypto.randomUUID();
  const form = await request.formData();
  const file = form.get("file");
  const parsed = Metadata.safeParse({
    jobId: form.get("jobId"),
    propertyId: form.get("propertyId"),
    zoneId: form.get("zoneId"),
  });
  if (!(file instanceof File) || !parsed.success || !allowedTypes.has(file.type) || file.size > maximumBytes) {
    return Response.json(
      {
        error: {
          code: "INVALID_EVIDENCE",
          message: "Use a JPEG, PNG, or WebP image no larger than 10 MB.",
          correlationId,
        },
      },
      { status: 400 },
    );
  }

  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = `EV-${crypto.randomUUID()}`;
  const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
  const objectKey = `ORG-NORTHSTAR/${parsed.data.jobId}/${id}.${extension}`;
  await env.EVIDENCE.put(objectKey, bytes, {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      organizationId: "ORG-NORTHSTAR",
      jobId: parsed.data.jobId,
      propertyId: parsed.data.propertyId,
      zoneId: parsed.data.zoneId,
      sha256,
    },
  });

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS evidence_assets (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    technician_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO evidence_assets (id, organization_id, job_id, property_id, zone_id, technician_id, object_key, kind, content_type, sha256, captured_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id,
    "ORG-NORTHSTAR",
    parsed.data.jobId,
    parsed.data.propertyId,
    parsed.data.zoneId,
    "TECH-04",
    objectKey,
    "FIELD_PHOTO",
    file.type,
    sha256,
    now,
    now,
    now,
    1,
  ).run();

  return Response.json({ data: { id, sha256, capturedAt: now }, correlationId }, { status: 201 });
}
