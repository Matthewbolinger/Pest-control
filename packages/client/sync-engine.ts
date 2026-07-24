import {
  assertJournalOperation,
  compareJournalOperations,
  DEFAULT_JOURNAL_LEASE_MS,
  hasContiguousConfirmedDependencyVersions,
  journalScopeKey,
  type JournalAttachment,
  type JournalCommitState,
  type JournalError,
  type JournalErrorDisposition,
  type JournalOperation,
  type JournalRecoveryAction,
  type JournalScope,
  type OfflineJournalStore,
} from "./offline-store";

export type ReplayBlockReason =
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_NEEDS_ACTION"
  | "WAITING_FOR_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "IN_FLIGHT"
  | "AUTHENTICATION_REQUIRED"
  | "RETRY_PAUSED"
  | "VERSION_REVIEW_REQUIRED";

export type ReplayBlock = Readonly<{
  operationId: string;
  reason: ReplayBlockReason;
  dependencyId?: string;
  message: string;
}>;

export type DeferredReplay = Readonly<{
  operationId: string;
  retryAt: number;
}>;

export type PlannedReplay = Readonly<{
  operation: JournalOperation;
  expectedVersion: number | null;
}>;

export type ReplayPlan = Readonly<{
  executionMode: "SERIAL_REPLAN_AFTER_CONFIRMATION";
  ready: readonly PlannedReplay[];
  blocked: readonly ReplayBlock[];
  deferred: readonly DeferredReplay[];
  projectedServerVersion: number;
}>;

export type ReplayPlanInput = Readonly<{
  scope: JournalScope;
  operations: readonly JournalOperation[];
  serverVersion: number;
  now: number;
  confirmedOperationIds?: ReadonlySet<string>;
}>;

export type SyncFailureInput = Readonly<{
  status?: number;
  code?: string;
  message?: string;
  correlationId?: string;
  commitState?: JournalCommitState;
}>;

export type SyncTransportRequest = Readonly<{
  operation: JournalOperation;
  attachment: JournalAttachment | null;
  signal?: AbortSignal;
}>;

export type SyncTransportReceipt = Readonly<{
  receiptId: string;
  serverVersion: number;
}>;

export interface OfflineSyncTransport {
  send(request: SyncTransportRequest): Promise<SyncTransportReceipt>;
}

export type ReplayExecutionResult = Readonly<{
  attempted: number;
  confirmed: number;
  serverVersion: number;
  plan: ReplayPlan;
  stoppedBecause:
    | "DRAINED"
    | "BLOCKED"
    | "DEFERRED"
    | "FAILED"
    | "ABORTED"
    | "LIMIT_REACHED";
}>;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;
const MAX_AUTOMATIC_ATTEMPTS = 8;
export const DEFAULT_SYNC_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OPERATIONS = 100;

export function planJournalReplay(input: ReplayPlanInput): ReplayPlan {
  assertPositiveVersion(input.serverVersion);
  assertTimestamp(input.now, "now");
  const expectedScopeKey = journalScopeKey(input.scope);
  const operations = [...input.operations].sort(compareJournalOperations);
  const byId = new Map<string, JournalOperation>();

  for (const operation of operations) {
    assertJournalOperation(operation);
    if (operation.scopeKey !== expectedScopeKey) {
      throw new Error("A replay plan cannot mix tenant, user, or job scopes.");
    }
    if (byId.has(operation.id)) {
      throw new Error(`Duplicate journal operation ${operation.id}.`);
    }
    byId.set(operation.id, operation);
  }

  const confirmed = new Set(input.confirmedOperationIds ?? []);
  const terminal = new Set<string>();
  const unavailable = new Set<string>();
  const blocked: ReplayBlock[] = [];
  const deferred: DeferredReplay[] = [];
  const candidates = new Map<string, JournalOperation>();
  let hasActiveClaim = false;

  for (const operation of operations) {
    if (operation.status === "CONFIRMED") {
      confirmed.add(operation.id);
      continue;
    }
    if (
      operation.status === "NEEDS_ACTION" ||
      operation.status === "CANCELLED"
    ) {
      terminal.add(operation.id);
      continue;
    }
    if (operation.status === "SYNCING") {
      hasActiveClaim = true;
      unavailable.add(operation.id);
      blocked.push({
        operationId: operation.id,
        reason: "IN_FLIGHT",
        message:
          "This scope already has an active replay claim; no other operation may start.",
      });
      continue;
    }
    if (operation.status === "AUTH_BLOCKED") {
      unavailable.add(operation.id);
      blocked.push({
        operationId: operation.id,
        reason: "AUTHENTICATION_REQUIRED",
        message: "Sign in again, then explicitly resume this operation.",
      });
      continue;
    }
    if (operation.status === "RETRY_PAUSED") {
      unavailable.add(operation.id);
      blocked.push({
        operationId: operation.id,
        reason: "RETRY_PAUSED",
        message:
          "Automatic retries are paused. The operation remains safe to resume.",
      });
      continue;
    }
    if (
      operation.status === "RETRY_WAIT" &&
      operation.nextAttemptAt !== null &&
      operation.nextAttemptAt > input.now
    ) {
      unavailable.add(operation.id);
      deferred.push({
        operationId: operation.id,
        retryAt: operation.nextAttemptAt,
      });
      continue;
    }
    candidates.set(operation.id, operation);
  }

  propagateFatalDependencies(candidates, byId, confirmed, terminal, blocked);

  const ready: PlannedReplay[] = [];
  let projectedServerVersion = input.serverVersion;

  while (!hasActiveClaim && candidates.size > 0 && ready.length === 0) {
    const roots = [...candidates.values()]
      .filter((operation) =>
        operation.dependsOn.every((dependency) => confirmed.has(dependency)),
      )
      .sort(compareJournalOperations);
    if (roots.length === 0) break;

    const operation = roots[0];
    const prepared = prepareVersion(
      operation,
      input.serverVersion,
      input.now,
      byId,
    );
    candidates.delete(operation.id);
    if (!prepared.operation) {
      blocked.push({
        operationId: operation.id,
        reason: "VERSION_REVIEW_REQUIRED",
        message: prepared.message,
      });
      terminal.add(operation.id);
      propagateFatalDependencies(candidates, byId, confirmed, terminal, blocked);
      continue;
    }

    ready.push({
      operation: prepared.operation,
      expectedVersion: prepared.operation.expectedVersion,
    });
    unavailable.add(operation.id);
    if (prepared.operation.advancesServerVersion) {
      projectedServerVersion += 1;
    }
  }

  for (const operation of [...candidates.values()].sort(
    compareJournalOperations,
  )) {
    const cycle = isInDependencyCycle(operation.id, candidates);
    const dependencyId = operation.dependsOn.find(
      (dependency) =>
        unavailable.has(dependency) || candidates.has(dependency),
    );
    blocked.push({
      operationId: operation.id,
      ...(dependencyId ? { dependencyId } : {}),
      reason: cycle ? "DEPENDENCY_CYCLE" : "WAITING_FOR_DEPENDENCY",
      message: cycle
        ? "The operation dependency graph contains a cycle."
        : hasActiveClaim
          ? "Replay is serialized while another operation is in flight."
          : "A required operation must be confirmed before this one can replay.",
    });
  }

  return {
    executionMode: "SERIAL_REPLAN_AFTER_CONFIRMATION",
    ready,
    blocked: dedupeBlocks(blocked).sort(compareBlocks),
    deferred: deferred.sort(
      (left, right) =>
        left.retryAt - right.retryAt ||
        left.operationId.localeCompare(right.operationId),
    ),
    projectedServerVersion,
  };
}

export function markSyncAttempt(
  operation: JournalOperation,
  now: number,
  leaseOwner = "local-sync-lease",
  leaseDurationMs = DEFAULT_JOURNAL_LEASE_MS,
): JournalOperation {
  assertJournalOperation(operation);
  assertTimestamp(now, "now");
  assertLeaseOwner(leaseOwner);
  if (
    operation.status !== "QUEUED" &&
    operation.status !== "RETRY_WAIT"
  ) {
    throw new Error("Only queued or retryable operations may begin syncing.");
  }
  if (
    operation.status === "RETRY_WAIT" &&
    operation.nextAttemptAt !== null &&
    operation.nextAttemptAt > now
  ) {
    throw new Error("The operation is not due for retry yet.");
  }
  if (now < operation.updatedAt) {
    throw new Error("A sync attempt cannot move time backwards.");
  }
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs < 1_000) {
    throw new Error("A sync lease must last at least one second.");
  }
  const next: JournalOperation = {
    ...operation,
    status: "SYNCING",
    attempts: operation.attempts + 1,
    revision: operation.revision + 1,
    lastAttemptAt: now,
    nextAttemptAt: null,
    updatedAt: now,
    leaseOwner,
    leaseExpiresAt: now + leaseDurationMs,
  };
  assertJournalOperation(next);
  return next;
}

export function confirmSyncOperation(
  operation: JournalOperation,
  input: Readonly<{
    receiptId: string;
    serverVersion: number;
    confirmedAt: number;
  }>,
): JournalOperation {
  assertJournalOperation(operation);
  if (operation.status !== "SYNCING") {
    throw new Error("Only an actively syncing operation may be confirmed.");
  }
  assertPositiveVersion(input.serverVersion);
  assertTimestamp(input.confirmedAt, "confirmedAt");
  if (input.confirmedAt < operation.updatedAt) {
    throw new Error("Confirmation cannot move the journal clock backwards.");
  }
  if (!input.receiptId.trim()) {
    throw new Error("A server receipt is required to confirm an operation.");
  }
  const next: JournalOperation = {
    ...operation,
    status: "CONFIRMED",
    revision: operation.revision + 1,
    updatedAt: input.confirmedAt,
    confirmedAt: input.confirmedAt,
    serverReceiptId: input.receiptId.trim(),
    serverVersion: input.serverVersion,
    nextAttemptAt: null,
    lastError: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  assertJournalOperation(next);
  return next;
}

export function classifySyncFailure(
  input: SyncFailureInput,
  occurredAt: number,
): JournalError {
  assertTimestamp(occurredAt, "occurredAt");
  const status = input.status;
  const code =
    input.code?.trim() ||
    (status ? `HTTP_${status}` : "NETWORK_UNAVAILABLE");
  const message =
    input.message?.trim() || "The operation could not be synchronized.";

  let disposition: JournalErrorDisposition;
  let commitState: JournalCommitState =
    input.commitState ?? defaultCommitState(status);
  let action: JournalRecoveryAction;

  if (status === 409 || code === "VERSION_CONFLICT") {
    disposition = "CONFLICT";
    commitState = "NOT_APPLIED";
    action = "REVIEW_CONFLICT";
  } else if (status === 401 || code === "AUTHENTICATION_REQUIRED") {
    disposition = "RETRYABLE";
    commitState = "NOT_APPLIED";
    action = "REAUTHENTICATE";
  } else if (
    status === 400 ||
    status === 413 ||
    status === 415 ||
    status === 422 ||
    code === "INVALID_EVIDENCE"
  ) {
    disposition = "PERMANENT";
    commitState = "NOT_APPLIED";
    action =
      code === "INVALID_EVIDENCE" || status === 413 || status === 415
        ? "REPLACE_ATTACHMENT"
        : "REVIEW_OPERATION";
  } else if (status === 403 || status === 404) {
    disposition = "PERMANENT";
    commitState = "NOT_APPLIED";
    action = "REVIEW_OPERATION";
  } else {
    disposition = "RETRYABLE";
    action = "RETRY";
  }

  return {
    code,
    message,
    disposition,
    commitState,
    action,
    occurredAt,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
}

export function recordSyncFailure(
  operation: JournalOperation,
  error: JournalError,
  now: number,
): JournalOperation {
  assertJournalOperation(operation);
  if (operation.status !== "SYNCING") {
    throw new Error("Only an actively syncing operation may record failure.");
  }
  assertTimestamp(now, "now");
  if (now < operation.updatedAt || error.occurredAt > now) {
    throw new Error("A sync failure cannot move the journal clock backwards.");
  }

  let status: JournalOperation["status"];
  let nextAttemptAt: number | null = null;
  let nextError = error;
  if (error.action === "REAUTHENTICATE") {
    status = "AUTH_BLOCKED";
  } else if (
    error.disposition === "RETRYABLE" &&
    operation.attempts >= MAX_AUTOMATIC_ATTEMPTS
  ) {
    status = "RETRY_PAUSED";
    nextError = {
      ...error,
      action: "CONTACT_SUPPORT",
      message: `${error.message} Automatic retries are paused; retry remains available.`,
      occurredAt: now,
    };
  } else if (error.disposition === "RETRYABLE") {
    status = "RETRY_WAIT";
    nextAttemptAt = now + retryDelayMs(operation.attempts);
  } else {
    status = "NEEDS_ACTION";
  }

  const next: JournalOperation = {
    ...operation,
    status,
    revision: operation.revision + 1,
    updatedAt: now,
    nextAttemptAt,
    lastError: nextError,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  assertJournalOperation(next);
  return next;
}

export function resumeBlockedOperation(
  operation: JournalOperation,
  now: number,
): JournalOperation {
  assertJournalOperation(operation);
  assertTimestamp(now, "now");
  if (
    operation.status !== "AUTH_BLOCKED" &&
    operation.status !== "RETRY_PAUSED"
  ) {
    throw new Error(
      "Only authentication-blocked or paused retries may be resumed.",
    );
  }
  if (now < operation.updatedAt) {
    throw new Error("Resuming sync cannot move the journal clock backwards.");
  }
  const next: JournalOperation = {
    ...operation,
    status: "QUEUED",
    revision: operation.revision + 1,
    updatedAt: now,
    nextAttemptAt: null,
    lastError: null,
  };
  assertJournalOperation(next);
  return next;
}

export function recoverInterruptedSync(
  operation: JournalOperation,
  now: number,
  staleAfterMs = DEFAULT_JOURNAL_LEASE_MS,
): JournalOperation {
  assertJournalOperation(operation);
  assertTimestamp(now, "now");
  if (
    operation.status !== "SYNCING" ||
    operation.lastAttemptAt === null ||
    operation.leaseExpiresAt === null ||
    now - operation.lastAttemptAt < staleAfterMs ||
    now < operation.leaseExpiresAt
  ) {
    return operation;
  }
  const error: JournalError = {
    code: "CLIENT_RESTART",
    message:
      "The previous sync result is unknown. Retry will use the same idempotency key.",
    disposition: "RETRYABLE",
    commitState: "UNKNOWN",
    action: "RETRY",
    occurredAt: now,
  };
  const next: JournalOperation = {
    ...operation,
    status: "RETRY_WAIT",
    revision: operation.revision + 1,
    updatedAt: now,
    nextAttemptAt: now,
    lastError: error,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  assertJournalOperation(next);
  return next;
}

export function retryDelayMs(attempts: number) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Retry delay requires at least one recorded attempt.");
  }
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

export class OfflineSyncExecutor {
  private readonly leaseOwner: string;
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxOperations: number;
  private readonly activeReplays = new Map<
    string,
    Promise<ReplayExecutionResult>
  >();

  constructor(
    private readonly store: OfflineJournalStore,
    private readonly transport: OfflineSyncTransport,
    options: Readonly<{
      leaseOwner?: string;
      now?: () => number;
      leaseDurationMs?: number;
      requestTimeoutMs?: number;
      maxOperations?: number;
    }> = {},
  ) {
    this.leaseOwner = options.leaseOwner ?? createLeaseOwner();
    assertLeaseOwner(this.leaseOwner);
    this.now = options.now ?? Date.now;
    this.leaseDurationMs =
      options.leaseDurationMs ?? DEFAULT_JOURNAL_LEASE_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_SYNC_REQUEST_TIMEOUT_MS;
    this.maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
    if (
      !Number.isInteger(this.maxOperations) ||
      this.maxOperations < 1 ||
      this.maxOperations > 1_000
    ) {
      throw new Error("maxOperations must be between 1 and 1000.");
    }
    if (
      !Number.isFinite(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1_000
    ) {
      throw new Error("requestTimeoutMs must last at least one second.");
    }
    if (
      !Number.isFinite(this.leaseDurationMs) ||
      this.leaseDurationMs <= this.requestTimeoutMs
    ) {
      throw new Error(
        "leaseDurationMs must be longer than requestTimeoutMs.",
      );
    }
  }

  replay(
    scope: JournalScope,
    serverVersion: number,
    signal?: AbortSignal,
  ): Promise<ReplayExecutionResult> {
    const scopeKey = journalScopeKey(scope);
    const active = this.activeReplays.get(scopeKey);
    if (active) return active;
    const replay = this.run(scope, serverVersion, signal).finally(() => {
      if (this.activeReplays.get(scopeKey) === replay) {
        this.activeReplays.delete(scopeKey);
      }
    });
    this.activeReplays.set(scopeKey, replay);
    return replay;
  }

  private async run(
    scope: JournalScope,
    initialServerVersion: number,
    signal?: AbortSignal,
  ): Promise<ReplayExecutionResult> {
    assertPositiveVersion(initialServerVersion);
    let serverVersion = initialServerVersion;
    let attempted = 0;
    let confirmed = 0;
    let contentionRetries = 0;

    while (attempted < this.maxOperations) {
      if (signal?.aborted) {
        return this.result(
          scope,
          serverVersion,
          attempted,
          confirmed,
          "ABORTED",
        );
      }

      const now = this.now();
      await this.store.recoverExpiredLeases(scope, now);
      const operations = await this.store.list(scope);
      const plan = planJournalReplay({
        scope,
        operations,
        serverVersion,
        now,
      });
      const next = plan.ready[0];
      if (!next) {
        const versionReview = plan.blocked.find(
          (block) => block.reason === "VERSION_REVIEW_REQUIRED",
        );
        if (versionReview) {
          const blockedOperation = operations.find(
            (operation) => operation.id === versionReview.operationId,
          );
          if (blockedOperation) {
            await this.store.requireVersionReview(
              scope,
              blockedOperation.id,
              {
                expectedRevision: blockedOperation.revision,
                now,
              },
            );
            continue;
          }
        }
        return {
          attempted,
          confirmed,
          serverVersion,
          plan,
          stoppedBecause:
            plan.deferred.length > 0
              ? "DEFERRED"
              : plan.blocked.length > 0
                ? "BLOCKED"
                : "DRAINED",
        };
      }

      const claimed = await this.store.claim(next.operation, {
        leaseOwner: this.leaseOwner,
        now,
        leaseDurationMs: this.leaseDurationMs,
      });
      if (!claimed) {
        contentionRetries += 1;
        if (contentionRetries > 20) {
          return this.result(
            scope,
            serverVersion,
            attempted,
            confirmed,
            "BLOCKED",
          );
        }
        continue;
      }

      contentionRetries = 0;
      attempted += 1;
      const attachment =
        claimed.kind === "EVIDENCE_UPLOAD"
          ? await this.store.getAttachment(claimed.scope, claimed.id)
          : null;

      try {
        if (claimed.kind === "EVIDENCE_UPLOAD" && !attachment) {
          throw new SyncTransportError({
            status: 400,
            code: "INVALID_EVIDENCE",
            message:
              "The evidence bytes are missing. Replace the attachment before retrying.",
            commitState: "NOT_APPLIED",
          });
        }
        const receipt = await this.sendWithTimeout(
          claimed,
          attachment,
          signal,
        );
        const completed = confirmSyncOperation(claimed, {
          receiptId: receipt.receiptId,
          serverVersion: receipt.serverVersion,
          confirmedAt: this.now(),
        });
        const committed = await this.store.commitClaim(completed, {
          expectedRevision: claimed.revision,
          leaseOwner: this.leaseOwner,
        });
        if (!committed) continue;
        serverVersion = receipt.serverVersion;
        confirmed += 1;
      } catch (error) {
        const occurredAt = this.now();
        const classified = classifySyncFailure(
          syncFailureInputFromUnknown(error),
          occurredAt,
        );
        const failed = recordSyncFailure(claimed, classified, occurredAt);
        await this.store.commitClaim(failed, {
          expectedRevision: claimed.revision,
          leaseOwner: this.leaseOwner,
        });
        if (
          failed.status === "NEEDS_ACTION" &&
          failed.lastError?.commitState === "NOT_APPLIED"
        ) {
          continue;
        }
        return this.result(
          scope,
          serverVersion,
          attempted,
          confirmed,
          signal?.aborted ? "ABORTED" : "FAILED",
        );
      }
    }

    return this.result(
      scope,
      serverVersion,
      attempted,
      confirmed,
      "LIMIT_REACHED",
    );
  }

  private async result(
    scope: JournalScope,
    serverVersion: number,
    attempted: number,
    confirmed: number,
    stoppedBecause: ReplayExecutionResult["stoppedBecause"],
  ): Promise<ReplayExecutionResult> {
    const plan = planJournalReplay({
      scope,
      operations: await this.store.list(scope),
      serverVersion,
      now: this.now(),
    });
    return { attempted, confirmed, serverVersion, plan, stoppedBecause };
  }

  private async sendWithTimeout(
    operation: JournalOperation,
    attachment: JournalAttachment | null,
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      relayAbort();
    } else {
      signal?.addEventListener("abort", relayAbort, { once: true });
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(
          new SyncTransportError({
            code: "SYNC_REQUEST_TIMEOUT",
            message:
              "The sync request timed out before its journal lease could expire.",
            commitState: "UNKNOWN",
          }),
        );
      }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([
        this.transport.send({
          operation,
          attachment,
          signal: controller.signal,
        }),
        timeoutFailure,
      ]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      signal?.removeEventListener("abort", relayAbort);
    }
  }
}

export class SyncTransportError extends Error {
  readonly failure: SyncFailureInput;

  constructor(failure: SyncFailureInput) {
    super(failure.message ?? failure.code ?? "Offline replay failed.");
    this.name = "SyncTransportError";
    this.failure = failure;
  }
}

export function createFieldProofHttpTransport(
  fetchImplementation: typeof fetch = fetch,
): OfflineSyncTransport {
  return {
    async send(request) {
      const { operation, attachment, signal } = request;
      const isEvidence = operation.kind === "EVIDENCE_UPLOAD";
      const response = isEvidence
        ? await sendEvidence(
            fetchImplementation,
            operation,
            attachment,
            signal,
          )
        : await sendWorkflowCommand(
            fetchImplementation,
            operation,
            signal,
          );
      const body = await readJsonObject(response);
      if (!response.ok) {
        const error = asObject(body.error);
        throw new SyncTransportError({
          status: response.status,
          code: asString(error.code),
          message: asString(error.message),
          correlationId:
            asString(body.correlationId) ?? response.headers.get("x-correlation-id") ?? undefined,
        });
      }

      const data = asObject(body.data);
      const snapshot = isEvidence ? asObject(data.snapshot) : data;
      const serverVersion = asPositiveInteger(snapshot.version);
      if (serverVersion === null) {
        throw new SyncTransportError({
          status: 502,
          code: "INVALID_SYNC_RECEIPT",
          message: "The server acknowledgement omitted its workflow version.",
          commitState: "UNKNOWN",
        });
      }
      const correlationId =
        asString(body.correlationId) ??
        response.headers.get("x-correlation-id");
      return {
        receiptId: correlationId ?? `idempotency:${operation.id}`,
        serverVersion,
      };
    },
  };
}

async function sendWorkflowCommand(
  fetchImplementation: typeof fetch,
  operation: JournalOperation,
  signal?: AbortSignal,
) {
  const payload = asObject(operation.payload);
  const type = asString(payload.type);
  const allowedTypes =
    operation.kind === "DRAFT_COMMAND"
      ? new Set([
          "CHECK_IN",
          "SET_CHECKLIST_STEP",
          "ADD_OBSERVATION",
          "REVIEW_RISK",
        ])
      : operation.kind === "COMPLETION_INTENT"
        ? new Set(["COMPLETE_JOB"])
        : operation.kind === "PROOF_DELIVERY"
          ? new Set(["SEND_PROOF"])
          : new Set<string>();
  if (!type || !allowedTypes.has(type)) {
    throw new SyncTransportError({
      status: 400,
      code: "INVALID_OFFLINE_COMMAND",
      message: `The ${operation.kind} payload does not contain an allowed command type.`,
      commitState: "NOT_APPLIED",
    });
  }
  if (operation.expectedVersion === null) {
    throw new SyncTransportError({
      status: 400,
      code: "INVALID_OFFLINE_COMMAND",
      message: "Workflow commands require an expected version.",
      commitState: "NOT_APPLIED",
    });
  }

  return fetchImplementation("/api/v1/workflow", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      "idempotency-key": operation.id,
    },
    body: JSON.stringify({
      ...payload,
      commandId: operation.id,
      expectedVersion: operation.expectedVersion,
    }),
    ...(signal ? { signal } : {}),
  });
}

async function sendEvidence(
  fetchImplementation: typeof fetch,
  operation: JournalOperation,
  attachment: JournalAttachment | null,
  signal?: AbortSignal,
) {
  if (!attachment) {
    throw new SyncTransportError({
      status: 400,
      code: "INVALID_EVIDENCE",
      message: "Evidence replay requires its durable attachment.",
      commitState: "NOT_APPLIED",
    });
  }
  const payload = asObject(operation.payload);
  const required = ["propertyId", "zoneId", "phase", "subject"] as const;
  for (const field of required) {
    if (!asString(payload[field])) {
      throw new SyncTransportError({
        status: 400,
        code: "INVALID_EVIDENCE",
        message: `Evidence replay is missing ${field}.`,
        commitState: "NOT_APPLIED",
      });
    }
  }
  const form = new FormData();
  form.set(
    "file",
    attachment.blob,
    attachment.fileName,
  );
  form.set("jobId", operation.scope.jobId);
  form.set("propertyId", String(payload.propertyId));
  form.set("zoneId", String(payload.zoneId));
  form.set("phase", String(payload.phase));
  form.set("subject", String(payload.subject));
  const caption = payload.caption;
  if (typeof caption === "string") form.set("caption", caption);
  form.set("capturedAt", String(attachment.capturedAt));

  return fetchImplementation("/api/v1/evidence", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "idempotency-key": operation.id },
    body: form,
    ...(signal ? { signal } : {}),
  });
}

function propagateFatalDependencies(
  candidates: Map<string, JournalOperation>,
  byId: ReadonlyMap<string, JournalOperation>,
  confirmed: ReadonlySet<string>,
  terminal: Set<string>,
  blocked: ReplayBlock[],
) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const operation of [...candidates.values()].sort(
      compareJournalOperations,
    )) {
      const missingDependency = operation.dependsOn.find(
        (dependency) => !byId.has(dependency) && !confirmed.has(dependency),
      );
      if (missingDependency) {
        blocked.push({
          operationId: operation.id,
          dependencyId: missingDependency,
          reason: "MISSING_DEPENDENCY",
          message: `Required operation ${missingDependency} is not available.`,
        });
        candidates.delete(operation.id);
        terminal.add(operation.id);
        changed = true;
        continue;
      }
      const failedDependency = operation.dependsOn.find((dependency) =>
        terminal.has(dependency),
      );
      if (failedDependency) {
        blocked.push({
          operationId: operation.id,
          dependencyId: failedDependency,
          reason: "DEPENDENCY_NEEDS_ACTION",
          message: `Required operation ${failedDependency} needs attention.`,
        });
        candidates.delete(operation.id);
        terminal.add(operation.id);
        changed = true;
      }
    }
  }
}

function prepareVersion(
  operation: JournalOperation,
  serverVersion: number,
  now: number,
  byId: ReadonlyMap<string, JournalOperation>,
):
  | { operation: JournalOperation; message: "" }
  | { operation: null; message: string } {
  if (operation.versionPolicy === "NONE") {
    return { operation, message: "" };
  }
  if (operation.attempts > 0) {
    // Never rebase an ambiguous request. Replaying its exact body and
    // idempotency key lets the server return the prior receipt if it committed,
    // or a definitive conflict if it did not.
    return { operation, message: "" };
  }
  if (
    operation.versionPolicy === "REBASABLE_DRAFT" &&
    operation.kind === "DRAFT_COMMAND" &&
    operation.serverReceiptId === null
  ) {
    const rebased: JournalOperation = {
      ...operation,
      expectedVersion: serverVersion,
      updatedAt: Math.max(operation.updatedAt, now),
    };
    assertJournalOperation(rebased);
    return { operation: rebased, message: "" };
  }
  if (
    operation.versionPolicy === "REBASABLE_DRAFT" &&
    operation.expectedVersion === serverVersion
  ) {
    return { operation, message: "" };
  }
  if (
    operation.versionPolicy === "PINNED" &&
    (operation.kind === "COMPLETION_INTENT" ||
      operation.kind === "PROOF_DELIVERY") &&
    operation.confirmedBaseVersion !== null
  ) {
    if (
      serverVersion === operation.confirmedBaseVersion &&
      operation.expectedVersion === serverVersion
    ) {
      return { operation, message: "" };
    }
    if (
      hasContiguousConfirmedDependencyVersions(
        operation,
        serverVersion,
        [...byId.values()],
      )
    ) {
      if (operation.expectedVersion === serverVersion) {
        return { operation, message: "" };
      }
      const dependencyAligned: JournalOperation = {
        ...operation,
        expectedVersion: serverVersion,
        updatedAt: Math.max(operation.updatedAt, now),
      };
      assertJournalOperation(dependencyAligned);
      return { operation: dependencyAligned, message: "" };
    }
  }
  return {
    operation: null,
    message:
      operation.versionPolicy === "REBASABLE_DRAFT"
        ? "The draft was already attempted, so changing its version could violate idempotency. Review the server state."
        : "The server version changed and this operation is pinned to its reviewed state.",
  };
}

function isInDependencyCycle(
  startId: string,
  candidates: ReadonlyMap<string, JournalOperation>,
) {
  const visited = new Set<string>();
  const active = new Set<string>();

  function visit(id: string): boolean {
    if (active.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    active.add(id);
    const operation = candidates.get(id);
    for (const dependency of operation?.dependsOn ?? []) {
      if (candidates.has(dependency) && visit(dependency)) return true;
    }
    active.delete(id);
    return false;
  }

  return visit(startId);
}

function defaultCommitState(status?: number): JournalCommitState {
  if (
    status &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    return "NOT_APPLIED";
  }
  return "UNKNOWN";
}

function syncFailureInputFromUnknown(error: unknown): SyncFailureInput {
  if (error instanceof SyncTransportError) return error.failure;
  if (error instanceof Error) {
    return {
      code: error.name === "AbortError" ? "REQUEST_ABORTED" : undefined,
      message: error.message,
      commitState: "UNKNOWN",
    };
  }
  return {
    message: "The operation could not be synchronized.",
    commitState: "UNKNOWN",
  };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    return asObject(await response.json());
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveInteger(value: unknown) {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function createLeaseOwner() {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `fieldproof:${id}`;
}

function dedupeBlocks(blocks: readonly ReplayBlock[]) {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = `${block.operationId}\u001f${block.reason}\u001f${block.dependencyId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareBlocks(left: ReplayBlock, right: ReplayBlock) {
  return (
    left.operationId.localeCompare(right.operationId) ||
    left.reason.localeCompare(right.reason)
  );
}

function assertLeaseOwner(value: string) {
  if (!/^[A-Za-z0-9:._-]{8,160}$/.test(value)) {
    throw new Error("A lease owner must be a stable opaque identifier.");
  }
}

function assertPositiveVersion(value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("serverVersion must be a positive integer.");
  }
}

function assertTimestamp(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative timestamp.`);
  }
}
