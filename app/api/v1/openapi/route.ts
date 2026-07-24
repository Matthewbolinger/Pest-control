const specification = {
  openapi: "3.1.0",
  info: {
    title: "FieldProof API",
    version: "0.2.0",
    description:
      "Authenticated API for the server-authoritative FieldProof pilot workflow.",
  },
  security: [{ platformIdentity: [] }],
  paths: {
    "/api/v1/health": {
      get: {
        summary: "Database, workflow, and outbox health",
        responses: {
          "200": { description: "Dependencies verified" },
          "401": { description: "Platform identity required" },
          "503": { description: "Dependency unavailable" },
        },
      },
    },
    "/api/v1/workflow": {
      get: {
        summary: "Load the authenticated tenant workflow",
        responses: {
          "200": { description: "Versioned workflow snapshot" },
          "401": { description: "Platform identity required" },
        },
      },
      post: {
        summary: "Apply an idempotent, versioned workflow command",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Authoritative workflow snapshot" },
          "400": { description: "Invalid command" },
          "401": { description: "Platform identity required" },
          "403": { description: "Cross-site write rejected" },
          "409": { description: "Invalid transition or version conflict" },
          "415": { description: "application/json required" },
        },
      },
    },
    "/api/v1/audit": {
      get: {
        summary: "List tenant-scoped authoritative audit events",
        responses: {
          "200": { description: "Audit events" },
          "401": { description: "Platform identity required" },
        },
      },
    },
    "/api/v1/evidence": {
      get: {
        summary: "Retrieve an authorized private evidence object",
        responses: {
          "200": { description: "Evidence bytes" },
          "400": { description: "Invalid evidence id" },
          "401": { description: "Platform identity required" },
          "404": { description: "Evidence not found in tenant" },
        },
      },
      post: {
        summary: "Upload attributable, idempotent evidence",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "201": { description: "Evidence and workflow snapshot stored" },
          "400": { description: "Invalid file, metadata, or content bytes" },
          "401": { description: "Platform identity required" },
          "403": { description: "Cross-site write rejected" },
          "409": { description: "Invalid job state or version conflict" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      platformIdentity: {
        type: "apiKey",
        in: "header",
        name: "oai-authenticated-user-email",
        description:
          "Injected by the hosting platform. Clients must not synthesize this header.",
      },
    },
  },
};

export async function GET() {
  return Response.json(specification);
}
