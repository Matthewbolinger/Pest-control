import { z } from "zod";

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9:._-]+$/, "Use a stable opaque idempotency key.");

export const ProviderKindSchema = z.enum([
  "MOCK",
  "CSV",
  "FIELDROUTES",
  "PESTPAC",
  "GORILLADESK",
]);

export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const CapabilityAvailabilitySchema = z.enum([
  "SUPPORTED",
  "UNSUPPORTED",
  "REQUIRES_VENDOR_VERIFICATION",
]);

const ProviderOperationsSchema = z
  .object({
    syncCustomers: CapabilityAvailabilitySchema,
    syncProperties: CapabilityAvailabilitySchema,
    syncTechnicians: CapabilityAvailabilitySchema,
    syncJobs: CapabilityAvailabilitySchema,
    writeAppointment: CapabilityAvailabilitySchema,
    writeJobCompletion: CapabilityAvailabilitySchema,
    incrementalCursors: CapabilityAvailabilitySchema,
    webhooks: CapabilityAvailabilitySchema,
    idempotentWrites: CapabilityAvailabilitySchema,
    dryRun: CapabilityAvailabilitySchema,
  })
  .strict();

export const ProviderCapabilitiesSchema = z
  .object({
    provider: ProviderKindSchema,
    transport: z.enum(["IN_MEMORY", "FILE", "REMOTE_API"]),
    credentialMode: z.enum(["NONE", "LOCAL_FILE", "PROVIDER_MANAGED"]),
    verification: z.enum(["LOCAL_VERIFIED", "REQUIRES_VENDOR_ACCESS"]),
    operations: ProviderOperationsSchema,
  })
  .strict();

export type ProviderCapabilities = z.infer<
  typeof ProviderCapabilitiesSchema
>;

const supportedOperations = {
  syncCustomers: "SUPPORTED",
  syncProperties: "SUPPORTED",
  syncTechnicians: "SUPPORTED",
  syncJobs: "SUPPORTED",
  writeAppointment: "SUPPORTED",
  writeJobCompletion: "SUPPORTED",
  incrementalCursors: "SUPPORTED",
  webhooks: "UNSUPPORTED",
  idempotentWrites: "SUPPORTED",
  dryRun: "UNSUPPORTED",
} as const;

const vendorVerificationOperations = {
  syncCustomers: "REQUIRES_VENDOR_VERIFICATION",
  syncProperties: "REQUIRES_VENDOR_VERIFICATION",
  syncTechnicians: "REQUIRES_VENDOR_VERIFICATION",
  syncJobs: "REQUIRES_VENDOR_VERIFICATION",
  writeAppointment: "REQUIRES_VENDOR_VERIFICATION",
  writeJobCompletion: "REQUIRES_VENDOR_VERIFICATION",
  incrementalCursors: "REQUIRES_VENDOR_VERIFICATION",
  webhooks: "REQUIRES_VENDOR_VERIFICATION",
  idempotentWrites: "REQUIRES_VENDOR_VERIFICATION",
  dryRun: "UNSUPPORTED",
} as const;

export const PROVIDER_CAPABILITIES: Readonly<
  Record<ProviderKind, ProviderCapabilities>
> = Object.freeze({
  MOCK: ProviderCapabilitiesSchema.parse({
    provider: "MOCK",
    transport: "IN_MEMORY",
    credentialMode: "NONE",
    verification: "LOCAL_VERIFIED",
    operations: supportedOperations,
  }),
  CSV: ProviderCapabilitiesSchema.parse({
    provider: "CSV",
    transport: "FILE",
    credentialMode: "LOCAL_FILE",
    verification: "LOCAL_VERIFIED",
    operations: {
      syncCustomers: "SUPPORTED",
      syncProperties: "SUPPORTED",
      syncTechnicians: "SUPPORTED",
      syncJobs: "SUPPORTED",
      writeAppointment: "UNSUPPORTED",
      writeJobCompletion: "UNSUPPORTED",
      incrementalCursors: "UNSUPPORTED",
      webhooks: "UNSUPPORTED",
      idempotentWrites: "SUPPORTED",
      dryRun: "SUPPORTED",
    },
  }),
  FIELDROUTES: ProviderCapabilitiesSchema.parse({
    provider: "FIELDROUTES",
    transport: "REMOTE_API",
    credentialMode: "PROVIDER_MANAGED",
    verification: "REQUIRES_VENDOR_ACCESS",
    operations: vendorVerificationOperations,
  }),
  PESTPAC: ProviderCapabilitiesSchema.parse({
    provider: "PESTPAC",
    transport: "REMOTE_API",
    credentialMode: "PROVIDER_MANAGED",
    verification: "REQUIRES_VENDOR_ACCESS",
    operations: vendorVerificationOperations,
  }),
  GORILLADESK: ProviderCapabilitiesSchema.parse({
    provider: "GORILLADESK",
    transport: "REMOTE_API",
    credentialMode: "PROVIDER_MANAGED",
    verification: "REQUIRES_VENDOR_ACCESS",
    operations: vendorVerificationOperations,
  }),
});

export function getProviderCapabilities(
  provider: ProviderKind,
): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[ProviderKindSchema.parse(provider)];
}

export const IntegrationErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1000),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();

export type IntegrationError = z.infer<typeof IntegrationErrorSchema>;

export type IntegrationResult<T> = {
  idempotencyKey: string;
  status: "SUCCEEDED" | "FAILED" | "DUPLICATE";
  data?: T;
  error?: string;
  errorDetails?: IntegrationError;
  attempt?: number;
  replayed?: boolean;
};

export const SyncEntityTypeSchema = z.enum([
  "CUSTOMER",
  "PROPERTY",
  "TECHNICIAN",
  "JOB",
  "APPOINTMENT",
  "JOB_COMPLETION",
]);

export type SyncEntityType = z.infer<typeof SyncEntityTypeSchema>;

export const SyncCursorSchema = z
  .object({
    provider: ProviderKindSchema,
    entityType: SyncEntityTypeSchema,
    token: z.string().min(1).max(1000),
    position: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    sourceVersion: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();

export type SyncCursor = z.infer<typeof SyncCursorSchema>;

export const SyncItemStatusSchema = z.enum([
  "CREATED",
  "UPDATED",
  "SKIPPED",
  "QUARANTINED",
  "FAILED",
]);

export const SyncItemOutcomeSchema = z
  .object({
    index: z.number().int().nonnegative(),
    entityType: SyncEntityTypeSchema,
    externalId: z.string().trim().min(1).max(500).nullable().default(null),
    status: SyncItemStatusSchema,
    reasonCode: z.string().trim().min(1).max(100).nullable().default(null),
    message: z.string().trim().min(1).max(1000).nullable().default(null),
    fingerprint: z.string().trim().min(1).max(500).nullable().default(null),
    retryable: z.boolean().default(false),
    error: IntegrationErrorSchema.nullable().default(null),
  })
  .strict()
  .superRefine((item, context) => {
    if (
      ["CREATED", "UPDATED", "SKIPPED"].includes(item.status) &&
      !item.externalId
    ) {
      context.addIssue({
        code: "custom",
        path: ["externalId"],
        message: `${item.status} outcomes require an externalId.`,
      });
    }
    if (item.status === "FAILED" && !item.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "FAILED outcomes require a structured error.",
      });
    }
    if (item.status !== "FAILED" && (item.retryable || item.error)) {
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message: "Only FAILED outcomes can be retryable or carry an error.",
      });
    }
    if (item.status === "FAILED" && item.error) {
      if (item.retryable !== item.error.retryable) {
        context.addIssue({
          code: "custom",
          path: ["retryable"],
          message: "Outcome and error retryability must agree.",
        });
      }
    }
    if (item.status === "QUARANTINED" && !item.reasonCode) {
      context.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "QUARANTINED outcomes require a reasonCode.",
      });
    }
  });

export type SyncItemOutcome = z.infer<typeof SyncItemOutcomeSchema>;

export const ReconciliationTotalsSchema = z
  .object({
    received: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    retryableFailures: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((totals, context) => {
    const received =
      totals.created +
      totals.updated +
      totals.skipped +
      totals.quarantined +
      totals.failed;
    if (totals.received !== received) {
      context.addIssue({
        code: "custom",
        path: ["received"],
        message: "received must equal all terminal item outcomes.",
      });
    }
    if (totals.succeeded !== totals.created + totals.updated + totals.skipped) {
      context.addIssue({
        code: "custom",
        path: ["succeeded"],
        message: "succeeded must equal created + updated + skipped.",
      });
    }
    if (totals.retryableFailures > totals.failed) {
      context.addIssue({
        code: "custom",
        path: ["retryableFailures"],
        message: "retryableFailures cannot exceed failed.",
      });
    }
  });

export type ReconciliationTotals = z.infer<
  typeof ReconciliationTotalsSchema
>;

export function buildReconciliationTotals(
  input: readonly SyncItemOutcome[],
): ReconciliationTotals {
  const items = input.map((item) => SyncItemOutcomeSchema.parse(item));
  const count = (status: z.infer<typeof SyncItemStatusSchema>) =>
    items.filter((item) => item.status === status).length;
  const created = count("CREATED");
  const updated = count("UPDATED");
  const skipped = count("SKIPPED");
  const quarantined = count("QUARANTINED");
  const failed = count("FAILED");
  return ReconciliationTotalsSchema.parse({
    received: items.length,
    created,
    updated,
    skipped,
    quarantined,
    failed,
    succeeded: created + updated + skipped,
    retryableFailures: items.filter(
      (item) => item.status === "FAILED" && item.retryable,
    ).length,
  });
}

export const SyncSourceItemSchema = z
  .object({
    externalId: z.string().trim().min(1).max(500),
    fingerprint: z.string().trim().min(1).max(500),
    validationErrors: z
      .array(z.string().trim().min(1).max(500))
      .max(50)
      .default([]),
  })
  .strict();

export type SyncSourceItem = z.infer<typeof SyncSourceItemSchema>;

export const SyncBatchRequestSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    entityType: SyncEntityTypeSchema,
    cursor: SyncCursorSchema.nullable().default(null),
    items: z.array(SyncSourceItemSchema).max(10_000),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.cursor && request.cursor.entityType !== request.entityType) {
      context.addIssue({
        code: "custom",
        path: ["cursor", "entityType"],
        message: "Cursor entityType must match the requested entityType.",
      });
    }
  });

export type SyncBatchRequest = z.infer<typeof SyncBatchRequestSchema>;

export const SyncRunStatusSchema = z.enum([
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "DUPLICATE",
]);

export const SyncBatchResultSchema = z
  .object({
    provider: ProviderKindSchema,
    entityType: SyncEntityTypeSchema,
    idempotencyKey: IdempotencyKeySchema,
    status: SyncRunStatusSchema,
    cursor: SyncCursorSchema,
    items: z.array(SyncItemOutcomeSchema),
    totals: ReconciliationTotalsSchema,
    replayed: z.boolean(),
    error: IntegrationErrorSchema.nullable().default(null),
  })
  .strict()
  .superRefine((result, context) => {
    const expected = countReconciliationTotals(result.items);
    for (const key of Object.keys(expected) as Array<
      keyof ReconciliationTotals
    >) {
      if (expected[key] !== result.totals[key]) {
        context.addIssue({
          code: "custom",
          path: ["totals", key],
          message: `totals.${key} does not match item outcomes.`,
        });
      }
    }
    if (result.status === "DUPLICATE" && !result.replayed) {
      context.addIssue({
        code: "custom",
        path: ["replayed"],
        message: "DUPLICATE results must be marked replayed.",
      });
    }
  });

export type SyncBatchResult = z.infer<typeof SyncBatchResultSchema>;

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(100),
    baseDelayMs: z.number().int().min(1).max(86_400_000),
    multiplier: z.number().min(1).max(10),
    maxDelayMs: z.number().int().min(1).max(604_800_000),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.maxDelayMs < policy.baseDelayMs) {
      context.addIssue({
        code: "custom",
        path: ["maxDelayMs"],
        message: "maxDelayMs must be greater than or equal to baseDelayMs.",
      });
    }
  });

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const DEFAULT_RETRY_POLICY = RetryPolicySchema.parse({
  maxAttempts: 5,
  baseDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 60_000,
});

export const RetryDecisionSchema = z
  .object({
    action: z.enum(["RETRY", "DEAD_LETTER"]),
    attempt: z.number().int().min(1),
    retryable: z.boolean(),
    exhausted: z.boolean(),
    delayMs: z.number().int().nonnegative().nullable(),
    nextAttemptAt: z.string().datetime().nullable(),
    reason: z.enum(["RETRYABLE_FAILURE", "NON_RETRYABLE", "ATTEMPTS_EXHAUSTED"]),
  })
  .strict();

export type RetryDecision = z.infer<typeof RetryDecisionSchema>;

export function decideIntegrationRetry(input: {
  attempt: number;
  error: IntegrationError;
  policy?: RetryPolicy;
  nowMs?: number;
}): RetryDecision {
  const attempt = z.number().int().min(1).parse(input.attempt);
  const error = IntegrationErrorSchema.parse(input.error);
  const policy = RetryPolicySchema.parse(
    input.policy ?? DEFAULT_RETRY_POLICY,
  );
  const nowMs = z.number().int().nonnegative().parse(input.nowMs ?? Date.now());

  if (!error.retryable) {
    return RetryDecisionSchema.parse({
      action: "DEAD_LETTER",
      attempt,
      retryable: false,
      exhausted: false,
      delayMs: null,
      nextAttemptAt: null,
      reason: "NON_RETRYABLE",
    });
  }
  if (attempt >= policy.maxAttempts) {
    return RetryDecisionSchema.parse({
      action: "DEAD_LETTER",
      attempt,
      retryable: true,
      exhausted: true,
      delayMs: null,
      nextAttemptAt: null,
      reason: "ATTEMPTS_EXHAUSTED",
    });
  }

  const exponentialDelay =
    policy.baseDelayMs * policy.multiplier ** (attempt - 1);
  const requestedDelay = error.retryAfterMs ?? exponentialDelay;
  const delayMs = Math.round(Math.min(policy.maxDelayMs, requestedDelay));
  return RetryDecisionSchema.parse({
    action: "RETRY",
    attempt,
    retryable: true,
    exhausted: false,
    delayMs,
    nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
    reason: "RETRYABLE_FAILURE",
  });
}

export interface FSMAdapter {
  syncCustomers(key: string): Promise<IntegrationResult<{ imported: number }>>;
  syncProperties(key: string): Promise<IntegrationResult<{ imported: number }>>;
  syncTechnicians(key: string): Promise<
    IntegrationResult<{ imported: number }>
  >;
  syncJobs(key: string): Promise<IntegrationResult<{ imported: number }>>;
  writeAppointment(
    key: string,
    appointmentId: string,
  ): Promise<IntegrationResult<{ externalId: string }>>;
  writeJobCompletion(
    key: string,
    jobId: string,
  ): Promise<IntegrationResult<{ externalId: string }>>;
}

export interface ReconciliableFSMAdapter extends FSMAdapter {
  readonly capabilities: ProviderCapabilities;
  syncBatch(
    input: z.input<typeof SyncBatchRequestSchema>,
  ): Promise<SyncBatchResult>;
}

export interface MapsAdapter {
  estimateDriveMinutes(origin: string, destination: string): Promise<number>;
}

export interface WeatherAdapter {
  getOperationalConditions(
    postalCode: string,
  ): Promise<{ summary: string; advisory: boolean }>;
}

export interface CommunicationsAdapter {
  sendServiceProof(
    key: string,
    recipientId: string,
    reportId: string,
  ): Promise<IntegrationResult<{ messageId: string }>>;
}

export interface ObjectStorageAdapter {
  createUploadUrl(input: {
    organizationId: string;
    objectKey: string;
    contentType: string;
  }): Promise<{ url: string; expiresAt: string }>;
}

export const MockOperationSchema = z.enum([
  "SYNC_CUSTOMERS",
  "SYNC_PROPERTIES",
  "SYNC_TECHNICIANS",
  "SYNC_JOBS",
  "SYNC_BATCH",
  "WRITE_APPOINTMENT",
  "WRITE_JOB_COMPLETION",
]);

export type MockOperation = z.infer<typeof MockOperationSchema>;

export const MockFailureRuleSchema = z
  .object({
    operation: MockOperationSchema,
    entityType: SyncEntityTypeSchema.nullable().default(null),
    matchKey: IdempotencyKeySchema.nullable().default(null),
    failuresBeforeSuccess: z.number().int().min(1).max(100),
    retryable: z.boolean(),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1000),
    retryAfterMs: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();

export const MockFSMAdapterOptionsSchema = z
  .object({
    failureRules: z.array(MockFailureRuleSchema).max(100).default([]),
  })
  .strict();

export type MockFSMAdapterOptions = z.input<
  typeof MockFSMAdapterOptionsSchema
>;

type StoredIntegrationSuccess = {
  signature: string;
  data: unknown;
  attempt: number;
};

export class MockFSMAdapter implements ReconciliableFSMAdapter {
  readonly capabilities = PROVIDER_CAPABILITIES.MOCK;

  private readonly options: z.output<typeof MockFSMAdapterOptionsSchema>;
  private readonly requestSignatures = new Map<string, string>();
  private readonly attempts = new Map<string, number>();
  private readonly successes = new Map<string, StoredIntegrationSuccess>();
  private readonly batchSuccesses = new Map<string, SyncBatchResult>();
  private readonly entityFingerprints = new Map<
    SyncEntityType,
    Map<string, string>
  >();

  constructor(options: MockFSMAdapterOptions = {}) {
    this.options = MockFSMAdapterOptionsSchema.parse(options);
  }

  /**
   * Loads the last durable source fingerprints before reconciliation. The mock
   * adapter is intentionally in-memory, so application services must hydrate a
   * fresh instance from their authoritative store on every request.
   */
  hydrateEntityFingerprints(
    entityTypeInput: unknown,
    fingerprintsInput: Readonly<Record<string, string>>,
  ) {
    const entityType = SyncEntityTypeSchema.parse(entityTypeInput);
    const fingerprints = z
      .record(
        z.string().trim().min(1).max(500),
        z.string().trim().min(1).max(500),
      )
      .parse(fingerprintsInput);
    this.entityFingerprints.set(
      entityType,
      new Map(Object.entries(fingerprints)),
    );
  }

  async syncCustomers(
    key: string,
  ): Promise<IntegrationResult<{ imported: number }>> {
    return this.execute(key, "SYNC_CUSTOMERS", "all", { imported: 40 });
  }

  async syncProperties(
    key: string,
  ): Promise<IntegrationResult<{ imported: number }>> {
    return this.execute(key, "SYNC_PROPERTIES", "all", { imported: 50 });
  }

  async syncTechnicians(
    key: string,
  ): Promise<IntegrationResult<{ imported: number }>> {
    return this.execute(key, "SYNC_TECHNICIANS", "all", { imported: 8 });
  }

  async syncJobs(
    key: string,
  ): Promise<IntegrationResult<{ imported: number }>> {
    return this.execute(key, "SYNC_JOBS", "all", { imported: 120 });
  }

  async writeAppointment(
    key: string,
    appointmentId: string,
  ): Promise<IntegrationResult<{ externalId: string }>> {
    return this.execute(key, "WRITE_APPOINTMENT", appointmentId, {
      externalId: `mock-appt-${appointmentId}`,
    });
  }

  async writeJobCompletion(
    key: string,
    jobId: string,
  ): Promise<IntegrationResult<{ externalId: string }>> {
    return this.execute(key, "WRITE_JOB_COMPLETION", jobId, {
      externalId: `mock-job-${jobId}`,
    });
  }

  async syncBatch(
    input: z.input<typeof SyncBatchRequestSchema>,
  ): Promise<SyncBatchResult> {
    const request = SyncBatchRequestSchema.parse(input);
    const signature = stableStringify({
      operation: "SYNC_BATCH",
      entityType: request.entityType,
      cursor: request.cursor,
      items: request.items,
    });
    const collision = this.idempotencyCollision(
      request.idempotencyKey,
      signature,
    );
    if (collision) {
      return this.failedBatch(
        request,
        integrationError(
          "IDEMPOTENCY_KEY_REUSED",
          "That idempotency key was already used for a different request.",
          false,
        ),
      );
    }

    const prior = this.batchSuccesses.get(request.idempotencyKey);
    if (prior) {
      return SyncBatchResultSchema.parse({
        ...prior,
        status: "DUPLICATE",
        replayed: true,
      });
    }

    if (request.cursor && request.cursor.provider !== "MOCK") {
      return this.failedBatch(
        request,
        integrationError(
          "CURSOR_PROVIDER_MISMATCH",
          "The cursor belongs to another provider.",
          false,
        ),
      );
    }

    const attempt = this.incrementAttempt(request.idempotencyKey);
    const failure = this.plannedFailure(
      "SYNC_BATCH",
      request.idempotencyKey,
      request.entityType,
      attempt,
    );
    if (failure) return this.failedBatch(request, failure);

    const store = this.storeFor(request.entityType);
    const outcomes = request.items.map((source, index) => {
      if (source.validationErrors.length > 0) {
        return syncItem({
          index,
          entityType: request.entityType,
          externalId: source.externalId,
          status: "QUARANTINED",
          reasonCode: "SOURCE_VALIDATION_FAILED",
          message: source.validationErrors.join("; "),
          fingerprint: source.fingerprint,
        });
      }

      const existing = store.get(source.externalId);
      if (existing === source.fingerprint) {
        return syncItem({
          index,
          entityType: request.entityType,
          externalId: source.externalId,
          status: "SKIPPED",
          reasonCode: "UNCHANGED",
          message: "Source fingerprint is unchanged.",
          fingerprint: source.fingerprint,
        });
      }

      const status = existing === undefined ? "CREATED" : "UPDATED";
      store.set(source.externalId, source.fingerprint);
      return syncItem({
        index,
        entityType: request.entityType,
        externalId: source.externalId,
        status,
        reasonCode: existing === undefined ? "NEW_EXTERNAL_ID" : "SOURCE_CHANGED",
        message:
          existing === undefined
            ? "Created from a new external record."
            : "Updated because the source fingerprint changed.",
        fingerprint: source.fingerprint,
      });
    });
    const totals = buildReconciliationTotals(outcomes);
    const position =
      (request.cursor?.position ?? 0) + request.items.length;
    const result = SyncBatchResultSchema.parse({
      provider: "MOCK",
      entityType: request.entityType,
      idempotencyKey: request.idempotencyKey,
      status: runStatus(totals),
      cursor: {
        provider: "MOCK",
        entityType: request.entityType,
        token: `mock:${request.entityType}:${position}`,
        position,
        hasMore: false,
        sourceVersion: `mock-v${position}`,
      },
      items: outcomes,
      totals,
      replayed: false,
      error: null,
    });
    this.batchSuccesses.set(request.idempotencyKey, result);
    return result;
  }

  private execute<T>(
    key: string,
    operation: MockOperation,
    resourceId: string,
    data: T,
  ): IntegrationResult<T> {
    const parsedKey = IdempotencyKeySchema.safeParse(key);
    if (!parsedKey.success) {
      return failedIntegrationResult(
        key,
        1,
        integrationError(
          "INVALID_IDEMPOTENCY_KEY",
          "The idempotency key is invalid.",
          false,
        ),
      );
    }

    const signature = stableStringify({ operation, resourceId });
    if (this.idempotencyCollision(parsedKey.data, signature)) {
      return failedIntegrationResult(
        parsedKey.data,
        this.attempts.get(parsedKey.data) ?? 1,
        integrationError(
          "IDEMPOTENCY_KEY_REUSED",
          "That idempotency key was already used for a different request.",
          false,
        ),
      );
    }

    const prior = this.successes.get(parsedKey.data);
    if (prior) {
      return {
        idempotencyKey: parsedKey.data,
        status: "DUPLICATE",
        data: prior.data as T,
        attempt: prior.attempt,
        replayed: true,
      };
    }

    const attempt = this.incrementAttempt(parsedKey.data);
    const failure = this.plannedFailure(
      operation,
      parsedKey.data,
      null,
      attempt,
    );
    if (failure) {
      return failedIntegrationResult(parsedKey.data, attempt, failure);
    }

    this.successes.set(parsedKey.data, {
      signature,
      data,
      attempt,
    });
    return {
      idempotencyKey: parsedKey.data,
      status: "SUCCEEDED",
      data,
      attempt,
      replayed: false,
    };
  }

  private idempotencyCollision(key: string, signature: string) {
    const prior = this.requestSignatures.get(key);
    if (prior && prior !== signature) return true;
    if (!prior) this.requestSignatures.set(key, signature);
    return false;
  }

  private incrementAttempt(key: string) {
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    return attempt;
  }

  private plannedFailure(
    operation: MockOperation,
    key: string,
    entityType: SyncEntityType | null,
    attempt: number,
  ) {
    const candidates = this.options.failureRules.filter(
      (rule) =>
        rule.operation === operation &&
        (!rule.matchKey || rule.matchKey === key) &&
        (!rule.entityType || rule.entityType === entityType),
    );
    const rule =
      candidates.find((candidate) => candidate.matchKey === key) ??
      candidates[0];
    if (!rule || attempt > rule.failuresBeforeSuccess) return null;
    return integrationError(
      rule.code,
      rule.message,
      rule.retryable,
      rule.retryAfterMs,
    );
  }

  private storeFor(entityType: SyncEntityType) {
    let store = this.entityFingerprints.get(entityType);
    if (!store) {
      store = new Map();
      this.entityFingerprints.set(entityType, store);
    }
    return store;
  }

  private failedBatch(
    request: SyncBatchRequest,
    error: IntegrationError,
  ): SyncBatchResult {
    const outcomes = request.items.map((item, index) =>
      syncItem({
        index,
        entityType: request.entityType,
        externalId: item.externalId,
        status: "FAILED",
        reasonCode: error.code,
        message: error.message,
        fingerprint: item.fingerprint,
        retryable: error.retryable,
        error,
      }),
    );
    const totals = buildReconciliationTotals(outcomes);
    return SyncBatchResultSchema.parse({
      provider: "MOCK",
      entityType: request.entityType,
      idempotencyKey: request.idempotencyKey,
      status: "FAILED",
      cursor: {
        provider: "MOCK",
        entityType: request.entityType,
        token: request.cursor?.token ?? `mock:${request.entityType}:failed`,
        position: request.cursor?.position ?? 0,
        hasMore: true,
        sourceVersion: request.cursor?.sourceVersion ?? null,
      },
      items: outcomes,
      totals,
      replayed: false,
      error,
    });
  }
}

export const CsvImportModeSchema = z.enum(["DRY_RUN", "IMPORT"]);

export const CsvImportRequestSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    entityType: SyncEntityTypeSchema,
    csv: z.string().max(10_000_000),
    requiredColumns: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .default([]),
  })
  .strict();

export type CsvImportRequest = z.infer<typeof CsvImportRequestSchema>;

export const CsvImportOptionsSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    entityType: SyncEntityTypeSchema,
    mode: CsvImportModeSchema,
    requiredColumns: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .default([]),
    existingFingerprints: z
      .record(z.string().min(1), z.string().min(1))
      .default({}),
  })
  .strict();

export type CsvImportOptions = z.input<typeof CsvImportOptionsSchema>;

export const CsvImportReportSchema = z
  .object({
    provider: z.literal("CSV"),
    entityType: SyncEntityTypeSchema,
    idempotencyKey: IdempotencyKeySchema,
    mode: CsvImportModeSchema,
    status: SyncRunStatusSchema,
    applied: z.boolean(),
    replayed: z.boolean(),
    headers: z.array(z.string()),
    cursor: SyncCursorSchema,
    items: z.array(SyncItemOutcomeSchema),
    totals: ReconciliationTotalsSchema,
    error: IntegrationErrorSchema.nullable().default(null),
  })
  .strict()
  .superRefine((report, context) => {
    const expected = countReconciliationTotals(report.items);
    for (const key of Object.keys(expected) as Array<
      keyof ReconciliationTotals
    >) {
      if (expected[key] !== report.totals[key]) {
        context.addIssue({
          code: "custom",
          path: ["totals", key],
          message: `totals.${key} does not match CSV item outcomes.`,
        });
      }
    }
    if (report.mode === "DRY_RUN" && report.applied) {
      context.addIssue({
        code: "custom",
        path: ["applied"],
        message: "A dry run cannot apply records.",
      });
    }
    if (report.status === "DUPLICATE" && !report.replayed) {
      context.addIssue({
        code: "custom",
        path: ["replayed"],
        message: "DUPLICATE reports must be marked replayed.",
      });
    }
  });

export type CsvImportReport = z.infer<typeof CsvImportReportSchema>;

export function parseCsvImport(
  csv: string,
  input: CsvImportOptions,
): CsvImportReport {
  const options = CsvImportOptionsSchema.parse(input);
  const checksum = hashText(csv);
  const cursor = SyncCursorSchema.parse({
    provider: "CSV",
    entityType: options.entityType,
    token: `csv:${checksum}`,
    position: 0,
    hasMore: false,
    sourceVersion: checksum,
  });

  let rows: ParsedCsvRow[];
  try {
    rows = tokenizeCsv(csv);
  } catch (error) {
    const message =
      error instanceof CsvSyntaxError
        ? error.message
        : "The CSV could not be parsed.";
    return csvFailureReport(
      options,
      cursor,
      [],
      message,
      error instanceof CsvSyntaxError ? error.line : 1,
      "CSV_SYNTAX_ERROR",
    );
  }

  if (rows.length === 0) {
    return csvFailureReport(
      options,
      cursor,
      [],
      "The CSV is empty.",
      1,
      "EMPTY_CSV",
    );
  }

  const headers = rows[0].values.map((value, index) =>
    normalizeHeader(index === 0 ? value.replace(/^\uFEFF/, "") : value),
  );
  const invalidHeader = validateHeaders(headers, options.requiredColumns);
  if (invalidHeader) {
    return csvFailureReport(
      options,
      cursor,
      headers,
      invalidHeader.message,
      rows[0].line,
      invalidHeader.code,
    );
  }

  const existing = new Map(Object.entries(options.existingFingerprints));
  const batch = new Map<string, string>();
  const outcomes: SyncItemOutcome[] = [];

  rows.slice(1).forEach((row) => {
    const index = outcomes.length;
    if (row.values.length !== headers.length) {
      outcomes.push(
        syncItem({
          index,
          entityType: options.entityType,
          status: "QUARANTINED",
          reasonCode: "COLUMN_COUNT_MISMATCH",
          message: `Line ${row.line} has ${row.values.length} columns; expected ${headers.length}.`,
        }),
      );
      return;
    }

    const record = Object.fromEntries(
      headers.map((header, column) => [
        header,
        row.values[column].trim(),
      ]),
    );
    const externalId = record.external_id;
    const missingColumns = [
      "external_id",
      ...options.requiredColumns.map(normalizeHeader),
    ].filter((column, position, all) => all.indexOf(column) === position)
      .filter((column) => !record[column]);
    if (!externalId || missingColumns.length > 0) {
      outcomes.push(
        syncItem({
          index,
          entityType: options.entityType,
          externalId: externalId || null,
          status: "QUARANTINED",
          reasonCode: "REQUIRED_VALUE_MISSING",
          message: `Line ${row.line} is missing: ${missingColumns.join(", ")}.`,
        }),
      );
      return;
    }

    const fingerprint = fingerprintCsvRecord(record);
    const duplicate = batch.get(externalId);
    if (duplicate) {
      outcomes.push(
        syncItem({
          index,
          entityType: options.entityType,
          externalId,
          status:
            duplicate === fingerprint ? "SKIPPED" : "QUARANTINED",
          reasonCode:
            duplicate === fingerprint
              ? "DUPLICATE_INPUT"
              : "CONFLICTING_DUPLICATE_EXTERNAL_ID",
          message:
            duplicate === fingerprint
              ? `Line ${row.line} duplicates an earlier identical row.`
              : `Line ${row.line} conflicts with an earlier row for ${externalId}.`,
          fingerprint,
        }),
      );
      return;
    }
    batch.set(externalId, fingerprint);

    const prior = existing.get(externalId);
    if (prior === fingerprint) {
      outcomes.push(
        syncItem({
          index,
          entityType: options.entityType,
          externalId,
          status: "SKIPPED",
          reasonCode: "UNCHANGED",
          message: "The imported record is unchanged.",
          fingerprint,
        }),
      );
      return;
    }

    outcomes.push(
      syncItem({
        index,
        entityType: options.entityType,
        externalId,
        status: prior === undefined ? "CREATED" : "UPDATED",
        reasonCode:
          prior === undefined ? "NEW_EXTERNAL_ID" : "SOURCE_CHANGED",
        message:
          prior === undefined
            ? "The import would create this record."
            : "The import would update this record.",
        fingerprint,
      }),
    );
  });

  const totals = buildReconciliationTotals(outcomes);
  return CsvImportReportSchema.parse({
    provider: "CSV",
    entityType: options.entityType,
    idempotencyKey: options.idempotencyKey,
    mode: options.mode,
    status: runStatus(totals),
    applied: false,
    replayed: false,
    headers,
    cursor: {
      ...cursor,
      position: rows.length - 1,
    },
    items: outcomes,
    totals,
    error: null,
  });
}

type StoredCsvReport = {
  signature: string;
  report: CsvImportReport;
};

export class CSVImportAdapter extends MockFSMAdapter {
  override readonly capabilities = PROVIDER_CAPABILITIES.CSV;

  private readonly csvState = new Map<
    SyncEntityType,
    Map<string, string>
  >();
  private readonly csvReports = new Map<string, StoredCsvReport>();

  async dryRunCsv(
    input: z.input<typeof CsvImportRequestSchema>,
  ): Promise<CsvImportReport> {
    return this.executeCsv(input, "DRY_RUN");
  }

  async importCsv(
    input: z.input<typeof CsvImportRequestSchema>,
  ): Promise<CsvImportReport> {
    return this.executeCsv(input, "IMPORT");
  }

  snapshotCsvState(entityType: SyncEntityType): Readonly<Record<string, string>> {
    return Object.freeze(
      Object.fromEntries(this.csvState.get(entityType)?.entries() ?? []),
    );
  }

  private async executeCsv(
    input: z.input<typeof CsvImportRequestSchema>,
    mode: z.infer<typeof CsvImportModeSchema>,
  ) {
    const request = CsvImportRequestSchema.parse(input);
    const signature = stableStringify({
      mode,
      entityType: request.entityType,
      csvHash: hashText(request.csv),
      requiredColumns: request.requiredColumns
        .map(normalizeHeader)
        .sort(),
    });
    const prior = this.csvReports.get(request.idempotencyKey);
    if (prior) {
      if (prior.signature !== signature) {
        const cursor = SyncCursorSchema.parse({
          provider: "CSV",
          entityType: request.entityType,
          token: `csv:${hashText(request.csv)}`,
          position: 0,
          hasMore: false,
          sourceVersion: hashText(request.csv),
        });
        return csvFailureReport(
          {
            idempotencyKey: request.idempotencyKey,
            entityType: request.entityType,
            mode,
            requiredColumns: request.requiredColumns,
            existingFingerprints: {},
          },
          cursor,
          [],
          "That idempotency key was already used for a different CSV request.",
          1,
          "IDEMPOTENCY_KEY_REUSED",
        );
      }
      return CsvImportReportSchema.parse({
        ...prior.report,
        status: "DUPLICATE",
        applied: false,
        replayed: true,
      });
    }

    const store = this.csvStoreFor(request.entityType);
    const report = parseCsvImport(request.csv, {
      idempotencyKey: request.idempotencyKey,
      entityType: request.entityType,
      mode,
      requiredColumns: request.requiredColumns,
      existingFingerprints: Object.fromEntries(store.entries()),
    });
    const canApply =
      mode === "IMPORT" &&
      (report.status !== "FAILED" ||
        report.totals.created + report.totals.updated > 0);
    if (canApply) {
      for (const item of report.items) {
        if (
          (item.status === "CREATED" || item.status === "UPDATED") &&
          item.externalId &&
          item.fingerprint
        ) {
          store.set(item.externalId, item.fingerprint);
        }
      }
    }
    const finalReport = CsvImportReportSchema.parse({
      ...report,
      applied: canApply,
    });
    this.csvReports.set(request.idempotencyKey, {
      signature,
      report: finalReport,
    });
    return finalReport;
  }

  private csvStoreFor(entityType: SyncEntityType) {
    let store = this.csvState.get(entityType);
    if (!store) {
      store = new Map();
      this.csvState.set(entityType, store);
    }
    return store;
  }
}

export function fingerprintCsvRecord(
  record: Readonly<Record<string, string>>,
) {
  const normalized = Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [normalizeHeader(key), value.trim()] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return hashText(stableStringify(normalized));
}

export class MockMapsAdapter implements MapsAdapter {
  async estimateDriveMinutes() {
    return 11;
  }
}

export class MockWeatherAdapter implements WeatherAdapter {
  async getOperationalConditions() {
    return { summary: "Dry, 72°F", advisory: false };
  }
}

export class MockCommunicationsAdapter implements CommunicationsAdapter {
  async sendServiceProof(
    key: string,
    _recipientId: string,
    reportId: string,
  ) {
    return {
      idempotencyKey: key,
      status: "SUCCEEDED" as const,
      data: { messageId: `msg-${reportId}` },
    };
  }
}

function syncItem(
  input: z.input<typeof SyncItemOutcomeSchema>,
): SyncItemOutcome {
  return SyncItemOutcomeSchema.parse(input);
}

function countReconciliationTotals(
  items: readonly SyncItemOutcome[],
): ReconciliationTotals {
  const count = (status: z.infer<typeof SyncItemStatusSchema>) =>
    items.filter((item) => item.status === status).length;
  const created = count("CREATED");
  const updated = count("UPDATED");
  const skipped = count("SKIPPED");
  const quarantined = count("QUARANTINED");
  const failed = count("FAILED");
  return {
    received: items.length,
    created,
    updated,
    skipped,
    quarantined,
    failed,
    succeeded: created + updated + skipped,
    retryableFailures: items.filter(
      (item) => item.status === "FAILED" && item.retryable,
    ).length,
  };
}

function runStatus(
  totals: ReconciliationTotals,
): z.infer<typeof SyncRunStatusSchema> {
  if (
    totals.received > 0 &&
    totals.succeeded === 0 &&
    totals.quarantined + totals.failed > 0
  ) {
    return "FAILED";
  }
  if (totals.quarantined > 0 || totals.failed > 0) return "PARTIAL";
  return "SUCCEEDED";
}

function integrationError(
  code: string,
  message: string,
  retryable: boolean,
  retryAfterMs: number | null = null,
): IntegrationError {
  return IntegrationErrorSchema.parse({
    code,
    message,
    retryable,
    retryAfterMs,
  });
}

function failedIntegrationResult<T>(
  idempotencyKey: string,
  attempt: number,
  error: IntegrationError,
): IntegrationResult<T> {
  return {
    idempotencyKey,
    status: "FAILED",
    error: error.message,
    errorDetails: error,
    attempt,
    replayed: false,
  };
}

type ParsedCsvRow = {
  line: number;
  values: string[];
};

class CsvSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "CsvSyntaxError";
  }
}

function tokenizeCsv(csv: string): ParsedCsvRow[] {
  const rows: ParsedCsvRow[] = [];
  let values: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;

  const finishRow = () => {
    values.push(field);
    field = "";
    if (values.some((value) => value.trim().length > 0)) {
      rows.push({ line: rowLine, values });
    }
    values = [];
  };

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (inQuotes) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
        if (character === "\n") line += 1;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true;
    } else if (character === ",") {
      values.push(field);
      field = "";
    } else if (character === "\n") {
      finishRow();
      line += 1;
      rowLine = line;
    } else if (character === "\r") {
      if (csv[index + 1] === "\n") index += 1;
      finishRow();
      line += 1;
      rowLine = line;
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new CsvSyntaxError(
      `Unterminated quoted field beginning on line ${rowLine}.`,
      rowLine,
    );
  }
  if (field.length > 0 || values.length > 0) finishRow();
  return rows;
}

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function validateHeaders(headers: string[], required: string[]) {
  if (headers.length === 0 || headers.some((header) => !header)) {
    return {
      code: "INVALID_HEADER",
      message: "Every CSV header must have a supported non-empty name.",
    };
  }
  if (new Set(headers).size !== headers.length) {
    return {
      code: "DUPLICATE_HEADER",
      message: "CSV headers must be unique after normalization.",
    };
  }
  const requiredHeaders = [
    "external_id",
    ...required.map(normalizeHeader),
  ].filter((header, index, all) => all.indexOf(header) === index);
  const missing = requiredHeaders.filter(
    (header) => !headers.includes(header),
  );
  if (missing.length > 0) {
    return {
      code: "REQUIRED_HEADER_MISSING",
      message: `CSV is missing required headers: ${missing.join(", ")}.`,
    };
  }
  return null;
}

function csvFailureReport(
  options: z.output<typeof CsvImportOptionsSchema>,
  cursor: SyncCursor,
  headers: string[],
  message: string,
  line: number,
  code: string,
): CsvImportReport {
  const item = syncItem({
    index: 0,
    entityType: options.entityType,
    status: "QUARANTINED",
    reasonCode: code,
    message: `Line ${line}: ${message}`,
  });
  const items = [item];
  return CsvImportReportSchema.parse({
    provider: "CSV",
    entityType: options.entityType,
    idempotencyKey: options.idempotencyKey,
    mode: options.mode,
    status: "FAILED",
    applied: false,
    replayed: false,
    headers,
    cursor,
    items,
    totals: buildReconciliationTotals(items),
    error: integrationError(code, message, false),
  });
}

function hashText(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}
