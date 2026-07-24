const specification = {
  openapi: "3.1.0",
  info: {
    title: "FieldProof API",
    version: "0.1.0",
    description: "Versioned API for the FieldProof vertical-slice MVP.",
  },
  paths: {
    "/api/v1/health": {
      get: { summary: "Service and queue health", responses: { "200": { description: "Healthy" } } },
    },
    "/api/v1/audit": {
      get: { summary: "List tenant-scoped audit events", responses: { "200": { description: "Audit events" } } },
      post: { summary: "Append an immutable audit event", responses: { "201": { description: "Created" }, "400": { description: "Invalid event" } } },
    },
    "/api/v1/evidence": {
      post: { summary: "Upload attributable evidence", responses: { "201": { description: "Stored" }, "400": { description: "Invalid file" } } },
    },
  },
};

export async function GET() {
  return Response.json(specification);
}
