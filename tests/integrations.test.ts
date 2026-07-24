import { describe, expect, it } from "vitest";
import {
  CSVImportAdapter,
  CsvImportReportSchema,
  DEFAULT_RETRY_POLICY,
  IntegrationErrorSchema,
  MockFSMAdapter,
  PROVIDER_CAPABILITIES,
  ProviderCapabilitiesSchema,
  ReconciliationTotalsSchema,
  RetryPolicySchema,
  SyncBatchResultSchema,
  SyncCursorSchema,
  SyncItemOutcomeSchema,
  buildReconciliationTotals,
  decideIntegrationRetry,
  fingerprintCsvRecord,
  getProviderCapabilities,
  parseCsvImport,
} from "../packages/integrations";

describe("provider capability contracts", () => {
  it("declares the complete supported provider set without implying remote verification", () => {
    expect(Object.keys(PROVIDER_CAPABILITIES)).toEqual([
      "MOCK",
      "CSV",
      "FIELDROUTES",
      "PESTPAC",
      "GORILLADESK",
    ]);
    expect(getProviderCapabilities("MOCK")).toMatchObject({
      transport: "IN_MEMORY",
      credentialMode: "NONE",
      verification: "LOCAL_VERIFIED",
      operations: {
        syncJobs: "SUPPORTED",
        writeJobCompletion: "SUPPORTED",
        incrementalCursors: "SUPPORTED",
        webhooks: "UNSUPPORTED",
        dryRun: "UNSUPPORTED",
      },
    });
    expect(getProviderCapabilities("CSV")).toMatchObject({
      transport: "FILE",
      credentialMode: "LOCAL_FILE",
      operations: {
        syncJobs: "SUPPORTED",
        writeJobCompletion: "UNSUPPORTED",
        incrementalCursors: "UNSUPPORTED",
        webhooks: "UNSUPPORTED",
        dryRun: "SUPPORTED",
      },
    });
    for (const provider of [
      "FIELDROUTES",
      "PESTPAC",
      "GORILLADESK",
    ] as const) {
      expect(getProviderCapabilities(provider)).toMatchObject({
        transport: "REMOTE_API",
        credentialMode: "PROVIDER_MANAGED",
        verification: "REQUIRES_VENDOR_ACCESS",
        operations: {
          syncJobs: "REQUIRES_VENDOR_VERIFICATION",
          writeJobCompletion: "REQUIRES_VENDOR_VERIFICATION",
        },
      });
    }
  });

  it("rejects undeclared capability fields and provider names", () => {
    expect(
      ProviderCapabilitiesSchema.safeParse({
        ...PROVIDER_CAPABILITIES.MOCK,
        secret: "must-not-pass",
      }).success,
    ).toBe(false);
    expect(() => getProviderCapabilities("UNKNOWN" as never)).toThrow();
  });
});

describe("item outcomes and reconciliation", () => {
  const transientError = IntegrationErrorSchema.parse({
    code: "UPSTREAM_TIMEOUT",
    message: "The provider timed out.",
    retryable: true,
  });

  const items = [
    SyncItemOutcomeSchema.parse({
      index: 0,
      entityType: "JOB",
      externalId: "job-1",
      status: "CREATED",
      fingerprint: "fp-1",
    }),
    SyncItemOutcomeSchema.parse({
      index: 1,
      entityType: "JOB",
      externalId: "job-2",
      status: "UPDATED",
      fingerprint: "fp-2",
    }),
    SyncItemOutcomeSchema.parse({
      index: 2,
      entityType: "JOB",
      externalId: "job-3",
      status: "SKIPPED",
      reasonCode: "UNCHANGED",
      fingerprint: "fp-3",
    }),
    SyncItemOutcomeSchema.parse({
      index: 3,
      entityType: "JOB",
      status: "QUARANTINED",
      reasonCode: "MISSING_EXTERNAL_ID",
      message: "External ID is required.",
    }),
    SyncItemOutcomeSchema.parse({
      index: 4,
      entityType: "JOB",
      externalId: "job-5",
      status: "FAILED",
      reasonCode: transientError.code,
      message: transientError.message,
      retryable: true,
      error: transientError,
    }),
  ];

  it("derives exact item-level totals including retryable failures", () => {
    expect(buildReconciliationTotals(items)).toEqual({
      received: 5,
      created: 1,
      updated: 1,
      skipped: 1,
      quarantined: 1,
      failed: 1,
      succeeded: 3,
      retryableFailures: 1,
    });
  });

  it("rejects contradictory item outcomes and arithmetic", () => {
    expect(
      SyncItemOutcomeSchema.safeParse({
        index: 0,
        entityType: "JOB",
        status: "CREATED",
      }).success,
    ).toBe(false);
    expect(
      SyncItemOutcomeSchema.safeParse({
        index: 0,
        entityType: "JOB",
        externalId: "job-1",
        status: "SKIPPED",
        retryable: true,
      }).success,
    ).toBe(false);
    expect(
      SyncItemOutcomeSchema.safeParse({
        index: 0,
        entityType: "JOB",
        externalId: "job-1",
        status: "FAILED",
        retryable: true,
      }).success,
    ).toBe(false);
    expect(
      ReconciliationTotalsSchema.safeParse({
        received: 2,
        created: 1,
        updated: 0,
        skipped: 0,
        quarantined: 0,
        failed: 0,
        succeeded: 1,
        retryableFailures: 0,
      }).success,
    ).toBe(false);
  });

  it("enforces strict, typed cursors", () => {
    const cursor = SyncCursorSchema.parse({
      provider: "MOCK",
      entityType: "JOB",
      token: "mock:JOB:10",
      position: 10,
      hasMore: true,
    });
    expect(cursor.sourceVersion).toBeNull();
    expect(
      SyncCursorSchema.safeParse({ ...cursor, unexpected: true }).success,
    ).toBe(false);
  });
});

describe("retry and dead-letter policy", () => {
  const policy = RetryPolicySchema.parse({
    maxAttempts: 4,
    baseDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 2_500,
  });
  const retryable = IntegrationErrorSchema.parse({
    code: "RATE_LIMITED",
    message: "Try again.",
    retryable: true,
  });

  it("uses deterministic capped exponential backoff", () => {
    const nowMs = Date.parse("2026-07-24T12:00:00.000Z");
    expect(
      decideIntegrationRetry({ attempt: 1, error: retryable, policy, nowMs }),
    ).toMatchObject({
      action: "RETRY",
      delayMs: 1_000,
      nextAttemptAt: "2026-07-24T12:00:01.000Z",
      reason: "RETRYABLE_FAILURE",
    });
    expect(
      decideIntegrationRetry({ attempt: 2, error: retryable, policy, nowMs }),
    ).toMatchObject({ action: "RETRY", delayMs: 2_000 });
    expect(
      decideIntegrationRetry({ attempt: 3, error: retryable, policy, nowMs }),
    ).toMatchObject({ action: "RETRY", delayMs: 2_500 });
  });

  it("honors retry-after within the policy cap", () => {
    const providerDelay = IntegrationErrorSchema.parse({
      ...retryable,
      retryAfterMs: 10_000,
    });
    expect(
      decideIntegrationRetry({
        attempt: 1,
        error: providerDelay,
        policy,
        nowMs: 0,
      }),
    ).toMatchObject({ action: "RETRY", delayMs: 2_500 });
  });

  it("dead-letters non-retryable and exhausted failures", () => {
    const permanent = IntegrationErrorSchema.parse({
      code: "INVALID_CREDENTIALS",
      message: "Credentials were rejected.",
      retryable: false,
    });
    expect(
      decideIntegrationRetry({
        attempt: 1,
        error: permanent,
        policy,
        nowMs: 0,
      }),
    ).toMatchObject({
      action: "DEAD_LETTER",
      retryable: false,
      exhausted: false,
      delayMs: null,
      reason: "NON_RETRYABLE",
    });
    expect(
      decideIntegrationRetry({
        attempt: 4,
        error: retryable,
        policy,
        nowMs: 0,
      }),
    ).toMatchObject({
      action: "DEAD_LETTER",
      retryable: true,
      exhausted: true,
      reason: "ATTEMPTS_EXHAUSTED",
    });
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
  });
});

describe("credential-free deterministic mock adapter", () => {
  it("preserves the original adapter operations and replays their result", async () => {
    const adapter = new MockFSMAdapter();
    const first = await adapter.syncJobs("sync-jobs-001");
    const replay = await adapter.syncJobs("sync-jobs-001");

    expect(first).toEqual({
      idempotencyKey: "sync-jobs-001",
      status: "SUCCEEDED",
      data: { imported: 120 },
      attempt: 1,
      replayed: false,
    });
    expect(replay).toEqual({
      idempotencyKey: "sync-jobs-001",
      status: "DUPLICATE",
      data: { imported: 120 },
      attempt: 1,
      replayed: true,
    });
  });

  it("rejects an idempotency key reused for another operation", async () => {
    const adapter = new MockFSMAdapter();
    await adapter.syncCustomers("shared-key-001");
    const collision = await adapter.writeAppointment(
      "shared-key-001",
      "appointment-1",
    );
    expect(collision).toMatchObject({
      status: "FAILED",
      errorDetails: {
        code: "IDEMPOTENCY_KEY_REUSED",
        retryable: false,
      },
    });
  });

  it("simulates transient failures, success, and replay deterministically", async () => {
    const adapter = new MockFSMAdapter({
      failureRules: [
        {
          operation: "SYNC_JOBS",
          failuresBeforeSuccess: 2,
          retryable: true,
          code: "UPSTREAM_TIMEOUT",
          message: "The simulated provider timed out.",
          retryAfterMs: 500,
        },
      ],
    });
    const first = await adapter.syncJobs("retry-jobs-001");
    const second = await adapter.syncJobs("retry-jobs-001");
    const third = await adapter.syncJobs("retry-jobs-001");
    const replay = await adapter.syncJobs("retry-jobs-001");

    expect(first).toMatchObject({
      status: "FAILED",
      attempt: 1,
      errorDetails: { code: "UPSTREAM_TIMEOUT", retryable: true },
    });
    expect(second).toMatchObject({ status: "FAILED", attempt: 2 });
    expect(third).toMatchObject({
      status: "SUCCEEDED",
      attempt: 3,
      data: { imported: 120 },
    });
    expect(replay).toMatchObject({
      status: "DUPLICATE",
      attempt: 3,
      data: { imported: 120 },
    });
  });

  it("reconciles create, update, skip, and quarantine outcomes", async () => {
    const adapter = new MockFSMAdapter();
    const first = await adapter.syncBatch({
      idempotencyKey: "batch-jobs-001",
      entityType: "JOB",
      items: [
        { externalId: "job-1", fingerprint: "fp-1" },
        {
          externalId: "job-invalid",
          fingerprint: "fp-invalid",
          validationErrors: ["Missing property mapping"],
        },
        { externalId: "job-2", fingerprint: "fp-2" },
      ],
    });

    expect(first.status).toBe("PARTIAL");
    expect(first.items.map((item) => item.status)).toEqual([
      "CREATED",
      "QUARANTINED",
      "CREATED",
    ]);
    expect(first.totals).toMatchObject({
      received: 3,
      created: 2,
      quarantined: 1,
      failed: 0,
    });
    expect(first.cursor).toMatchObject({
      provider: "MOCK",
      entityType: "JOB",
      position: 3,
      hasMore: false,
    });

    const secondRequest = {
      idempotencyKey: "batch-jobs-002",
      entityType: "JOB" as const,
      cursor: first.cursor,
      items: [
        { externalId: "job-1", fingerprint: "fp-1" },
        { externalId: "job-2", fingerprint: "fp-2-changed" },
      ],
    };
    const second = await adapter.syncBatch(secondRequest);
    expect(second.status).toBe("SUCCEEDED");
    expect(second.items.map((item) => item.status)).toEqual([
      "SKIPPED",
      "UPDATED",
    ]);
    expect(second.cursor.position).toBe(5);
    expect(SyncBatchResultSchema.parse(second)).toEqual(second);

    const replay = await adapter.syncBatch(secondRequest);
    expect(replay).toMatchObject({
      status: "DUPLICATE",
      replayed: true,
      totals: second.totals,
    });
  });

  it("hydrates a fresh adapter from durable fingerprints before classifying outcomes", async () => {
    const adapter = new MockFSMAdapter();
    adapter.hydrateEntityFingerprints("JOB", {
      "job-unchanged": "fp-1",
      "job-changed": "fp-old",
    });

    const result = await adapter.syncBatch({
      idempotencyKey: "batch-hydrated-001",
      entityType: "JOB",
      items: [
        { externalId: "job-unchanged", fingerprint: "fp-1" },
        { externalId: "job-changed", fingerprint: "fp-new" },
        { externalId: "job-new", fingerprint: "fp-new" },
      ],
    });

    expect(result.items.map((item) => item.status)).toEqual([
      "SKIPPED",
      "UPDATED",
      "CREATED",
    ]);
    expect(result.totals).toMatchObject({
      received: 3,
      created: 1,
      updated: 1,
      skipped: 1,
      succeeded: 3,
    });
  });

  it("reports batch-level retryable failures per item without applying them", async () => {
    const adapter = new MockFSMAdapter({
      failureRules: [
        {
          operation: "SYNC_BATCH",
          entityType: "PROPERTY",
          failuresBeforeSuccess: 1,
          retryable: true,
          code: "RATE_LIMITED",
          message: "Slow down.",
        },
      ],
    });
    const request = {
      idempotencyKey: "batch-properties-001",
      entityType: "PROPERTY" as const,
      items: [
        { externalId: "property-1", fingerprint: "fp-1" },
        { externalId: "property-2", fingerprint: "fp-2" },
      ],
    };
    const failed = await adapter.syncBatch(request);
    expect(failed).toMatchObject({
      status: "FAILED",
      totals: {
        received: 2,
        failed: 2,
        retryableFailures: 2,
      },
      error: { code: "RATE_LIMITED", retryable: true },
    });

    const succeeded = await adapter.syncBatch(request);
    expect(succeeded).toMatchObject({
      status: "SUCCEEDED",
      totals: { created: 2, failed: 0 },
    });
  });
});

describe("dependency-free CSV evaluation", () => {
  it("handles quoted commas, escaped quotes, CRLF, duplicates, and quarantine", () => {
    const unchanged = fingerprintCsvRecord({
      external_id: "customer-1",
      name: "Acme, Inc.",
      address: '1 "Main" St',
    });
    const csv = [
      "external_id,name,address",
      '"customer-1","Acme, Inc.","1 ""Main"" St"',
      "customer-2,Beta,2 Main St",
      "customer-2,Beta,2 Main St",
      "customer-3,,3 Main St",
      "customer-4,Delta,4 Main St,unexpected",
    ].join("\r\n");

    const report = parseCsvImport(csv, {
      idempotencyKey: "csv-eval-001",
      entityType: "CUSTOMER",
      mode: "DRY_RUN",
      requiredColumns: ["name"],
      existingFingerprints: { "customer-1": unchanged },
    });

    expect(report.status).toBe("PARTIAL");
    expect(report.applied).toBe(false);
    expect(report.items.map((item) => item.status)).toEqual([
      "SKIPPED",
      "CREATED",
      "SKIPPED",
      "QUARANTINED",
      "QUARANTINED",
    ]);
    expect(report.items[0].fingerprint).toBe(unchanged);
    expect(report.totals).toEqual({
      received: 5,
      created: 1,
      updated: 0,
      skipped: 2,
      quarantined: 2,
      failed: 0,
      succeeded: 3,
      retryableFailures: 0,
    });
    expect(report.cursor).toMatchObject({
      provider: "CSV",
      entityType: "CUSTOMER",
      position: 5,
      hasMore: false,
    });
    expect(CsvImportReportSchema.parse(report)).toEqual(report);
  });

  it("classifies a changed existing fingerprint as updated", () => {
    const report = parseCsvImport("external_id,name\ncustomer-1,New Name", {
      idempotencyKey: "csv-update-001",
      entityType: "CUSTOMER",
      mode: "DRY_RUN",
      requiredColumns: ["name"],
      existingFingerprints: { "customer-1": "old-fingerprint" },
    });
    expect(report).toMatchObject({
      status: "SUCCEEDED",
      totals: { received: 1, updated: 1 },
      items: [{ externalId: "customer-1", status: "UPDATED" }],
    });
  });

  it("returns quarantined reports for invalid files instead of throwing", () => {
    const empty = parseCsvImport("", {
      idempotencyKey: "csv-empty-001",
      entityType: "JOB",
      mode: "DRY_RUN",
    });
    expect(empty).toMatchObject({
      status: "FAILED",
      totals: { quarantined: 1 },
      error: { code: "EMPTY_CSV", retryable: false },
    });

    const missingHeader = parseCsvImport("name\nExample", {
      idempotencyKey: "csv-header-001",
      entityType: "JOB",
      mode: "DRY_RUN",
    });
    expect(missingHeader).toMatchObject({
      status: "FAILED",
      error: { code: "REQUIRED_HEADER_MISSING" },
    });

    const unterminated = parseCsvImport(
      'external_id,name\njob-1,"Unclosed',
      {
        idempotencyKey: "csv-syntax-001",
        entityType: "JOB",
        mode: "DRY_RUN",
      },
    );
    expect(unterminated).toMatchObject({
      status: "FAILED",
      error: { code: "CSV_SYNTAX_ERROR", retryable: false },
    });
  });

  it("quarantines a conflicting duplicate external ID", () => {
    const report = parseCsvImport(
      "external_id,name\ncustomer-1,First\ncustomer-1,Second",
      {
        idempotencyKey: "csv-conflict-001",
        entityType: "CUSTOMER",
        mode: "DRY_RUN",
      },
    );
    expect(report.items.map((item) => item.status)).toEqual([
      "CREATED",
      "QUARANTINED",
    ]);
    expect(report.items[1].reasonCode).toBe(
      "CONFLICTING_DUPLICATE_EXTERNAL_ID",
    );
  });
});

describe("CSV adapter dry-run, import, and idempotency", () => {
  const initialCsv = "external_id,name\ncustomer-1,Avery";

  it("keeps dry runs side-effect free and applies imports once", async () => {
    const adapter = new CSVImportAdapter();
    const dryRun = await adapter.dryRunCsv({
      idempotencyKey: "csv-dry-001",
      entityType: "CUSTOMER",
      csv: initialCsv,
      requiredColumns: ["name"],
    });
    expect(dryRun).toMatchObject({
      mode: "DRY_RUN",
      status: "SUCCEEDED",
      applied: false,
      totals: { created: 1 },
    });
    expect(adapter.snapshotCsvState("CUSTOMER")).toEqual({});

    const imported = await adapter.importCsv({
      idempotencyKey: "csv-import-001",
      entityType: "CUSTOMER",
      csv: initialCsv,
      requiredColumns: ["name"],
    });
    expect(imported).toMatchObject({
      mode: "IMPORT",
      status: "SUCCEEDED",
      applied: true,
      replayed: false,
      totals: { created: 1 },
    });
    expect(Object.keys(adapter.snapshotCsvState("CUSTOMER"))).toEqual([
      "customer-1",
    ]);

    const replay = await adapter.importCsv({
      idempotencyKey: "csv-import-001",
      entityType: "CUSTOMER",
      csv: initialCsv,
      requiredColumns: ["name"],
    });
    expect(replay).toMatchObject({
      status: "DUPLICATE",
      applied: false,
      replayed: true,
      totals: imported.totals,
    });
  });

  it("reports unchanged and updated records against imported state", async () => {
    const adapter = new CSVImportAdapter();
    await adapter.importCsv({
      idempotencyKey: "csv-seed-001",
      entityType: "CUSTOMER",
      csv: initialCsv,
    });

    const unchanged = await adapter.importCsv({
      idempotencyKey: "csv-unchanged-001",
      entityType: "CUSTOMER",
      csv: initialCsv,
    });
    expect(unchanged).toMatchObject({
      status: "SUCCEEDED",
      applied: true,
      totals: { skipped: 1 },
    });

    const updated = await adapter.importCsv({
      idempotencyKey: "csv-updated-001",
      entityType: "CUSTOMER",
      csv: "external_id,name\ncustomer-1,Avery Updated",
    });
    expect(updated).toMatchObject({
      status: "SUCCEEDED",
      applied: true,
      totals: { updated: 1 },
    });
    expect(adapter.snapshotCsvState("CUSTOMER")["customer-1"]).toBe(
      updated.items[0].fingerprint,
    );
  });

  it("applies valid rows from a partial import and quarantines invalid rows", async () => {
    const adapter = new CSVImportAdapter();
    const report = await adapter.importCsv({
      idempotencyKey: "csv-partial-001",
      entityType: "PROPERTY",
      csv: "external_id,address\nproperty-1,1 Main St\n,Missing ID",
      requiredColumns: ["address"],
    });
    expect(report).toMatchObject({
      status: "PARTIAL",
      applied: true,
      totals: { created: 1, quarantined: 1 },
    });
    expect(Object.keys(adapter.snapshotCsvState("PROPERTY"))).toEqual([
      "property-1",
    ]);
  });

  it("fails closed when an idempotency key is reused for different CSV", async () => {
    const adapter = new CSVImportAdapter();
    await adapter.importCsv({
      idempotencyKey: "csv-collision-001",
      entityType: "CUSTOMER",
      csv: initialCsv,
    });
    const collision = await adapter.importCsv({
      idempotencyKey: "csv-collision-001",
      entityType: "CUSTOMER",
      csv: "external_id,name\ncustomer-2,Jordan",
    });
    expect(collision).toMatchObject({
      status: "FAILED",
      applied: false,
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        retryable: false,
      },
    });
    expect(adapter.snapshotCsvState("CUSTOMER")).not.toHaveProperty(
      "customer-2",
    );
  });
});
