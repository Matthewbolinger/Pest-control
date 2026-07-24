const specification = {
  openapi: "3.1.0",
  info: {
    title: "FieldProof API",
    version: "0.2.0",
    description:
      "Authenticated, tenant-scoped API for FieldProof outcome assurance, evidence, economics, integrations, and durable delivery.",
  },
  security: [{ platformIdentity: [] }],
  paths: {
    "/api/v1/version": {
      get: {
        security: [],
        summary: "Read the immutable build fingerprint",
        responses: {
          "200": { description: "Service version and source build SHA" },
        },
      },
    },
    "/api/v1/me": {
      get: {
        summary: "Read the active database-backed membership",
        responses: {
          "200": { description: "Identity, role, and explicit permissions" },
          "401": { description: "Platform identity required" },
          "403": { description: "Active organization membership required" },
        },
      },
    },
    "/api/v1/operations": {
      get: {
        summary: "Read normalized operating records for the active job",
        responses: {
          "200": {
            description:
              "Tenant-scoped customer, property, request, job, confirmed appointment, evidence policy, economics, outcome, proof, and integration projections",
          },
          "403": { description: "Role or assignment does not grant access" },
        },
      },
    },
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
        summary:
          "Apply an idempotent, authorized, optimistic workflow command",
        description:
          "Field completion creates PENDING_VERIFICATION. VERIFY_OUTCOME is a separate independent action. SEND_PROOF queues delivery and never implies provider confirmation.",
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
        summary: "Upload typed, attributable, idempotent evidence",
        description:
          "Multipart fields: file, jobId, propertyId, zoneId, phase, subject, caption, and capturedAt. The server validates assignment, relationships, file bytes, capture time, hash, and the active evidence policy.",
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
    "/api/v1/integrations": {
      get: {
        summary: "Inspect connectors, capabilities, sync runs, and errors",
        responses: {
          "200": { description: "Connector observability" },
          "403": { description: "Integration management permission required" },
        },
      },
      post: {
        summary: "Run an idempotent mock shadow reconciliation",
        description:
          "The production FieldRoutes, PestPac, and GorillaDesk capability matrix remains credential-gated until verified against vendor access.",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "201": { description: "Reconciliation persisted" },
          "409": { description: "Idempotency key reused" },
          "502": { description: "Mock upstream failure persisted" },
        },
      },
    },
    "/api/v1/outbox": {
      get: {
        summary: "Inspect durable events and proof delivery truth",
        responses: {
          "200": { description: "Delivery and outbox health" },
          "403": { description: "Proof-send permission required" },
        },
      },
      post: {
        summary: "Claim and process one pending proof delivery",
        description:
          "Uses a deterministic mock communications adapter in the pilot. Only provider-confirmed success becomes DELIVERED; lease ownership fences every mutation, and success requires a concrete reconciled workflow version.",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Delivery confirmed or queue idle" },
          "409": { description: "Delivery already claimed" },
          "422": { description: "Delivery dead-lettered" },
          "503": { description: "Retry scheduled or dependency unavailable" },
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
