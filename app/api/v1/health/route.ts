export async function GET() {
  return Response.json({
    status: "ok",
    service: "fieldproof",
    version: "0.1.0",
    queues: {
      ai: "mock-inline",
      reports: "outbox-backed",
      risk: "outbox-backed",
      integrations: "mock",
    },
    timestamp: new Date().toISOString(),
  });
}
