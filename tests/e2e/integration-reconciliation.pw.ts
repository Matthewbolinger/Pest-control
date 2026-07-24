import { expect, test, type APIRequestContext } from "@playwright/test";

test("mock shadow sync reconciles against durable mappings across requests", async ({
  request,
}) => {
  const firstKey = `e2e-integration-first-${crypto.randomUUID()}`;
  const first = await runSync(request, firstKey);
  expect(first.response.status()).toBe(201);
  expect(first.body.data?.items?.map((item) => item.status)).toHaveLength(3);

  const secondKey = `e2e-integration-second-${crypto.randomUUID()}`;
  const second = await runSync(request, secondKey);
  expect(second.response.status()).toBe(201);
  expect(second.body).toMatchObject({
    idempotent: false,
    data: {
      status: "PARTIAL",
      totals: {
        received: 3,
        created: 0,
        updated: 0,
        skipped: 2,
        quarantined: 1,
        failed: 0,
        succeeded: 2,
      },
      items: [
        { externalId: "fsm-job-2048", status: "SKIPPED" },
        { externalId: "fsm-job-2049", status: "SKIPPED" },
        { externalId: "fsm-job-invalid", status: "QUARANTINED" },
      ],
    },
  });

  const replay = await runSync(request, secondKey);
  expect(replay.response.ok()).toBe(true);
  expect(replay.body).toMatchObject({
    idempotent: true,
    data: {
      totals: second.body.data?.totals,
      items: second.body.data?.items,
    },
  });

  const capabilities = await request.get("/api/v1/integrations", {
    headers: { accept: "application/json" },
  });
  expect(capabilities.ok()).toBe(true);
  const capabilityBody = (await capabilities.json()) as {
    data?: {
      providerCapabilities?: {
        MOCK?: {
          operations?: Record<string, string>;
        };
        CSV?: {
          operations?: Record<string, string>;
        };
      };
    };
  };
  expect(
    capabilityBody.data?.providerCapabilities?.MOCK?.operations,
  ).toMatchObject({
    incrementalCursors: "SUPPORTED",
    webhooks: "UNSUPPORTED",
    dryRun: "UNSUPPORTED",
  });
  expect(
    capabilityBody.data?.providerCapabilities?.CSV?.operations,
  ).toMatchObject({
    incrementalCursors: "UNSUPPORTED",
    webhooks: "UNSUPPORTED",
    dryRun: "SUPPORTED",
  });
});

async function runSync(
  request: APIRequestContext,
  idempotencyKey: string,
) {
  const response = await request.post("/api/v1/integrations", {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    data: {
      type: "RUN_MOCK_SYNC",
      idempotencyKey,
      simulateFailure: false,
    },
  });
  const body = (await response.json()) as {
    idempotent?: boolean;
    data?: {
      status?: string;
      totals?: Record<string, number>;
      items?: Array<{
        externalId?: string | null;
        status?: string;
      }>;
    };
    error?: { code?: string; message?: string };
  };
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return { response, body };
}
