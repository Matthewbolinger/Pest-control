export const OFFLINE_JOURNAL_DB = "fieldproof-offline-journal";
export const OFFLINE_JOURNAL_DB_VERSION = 4;
export const DEFAULT_JOURNAL_LEASE_MS = 60_000;

const OPERATIONS_STORE = "operations";
const ATTACHMENTS_STORE = "attachments";
const METADATA_STORE = "metadata";
const QUARANTINE_STORE = "quarantine";
const SCOPE_SEQUENCE_INDEX = "byScopeSequence";
const SCOPE_INDEX = "byScope";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type JournalScope = Readonly<{
  organizationId: string;
  actorId: string;
  jobId: string;
}>;

export type ActorScope = Readonly<{
  organizationId: string;
  actorId: string;
}>;

export type JournalOperationKind =
  | "DRAFT_COMMAND"
  | "EVIDENCE_UPLOAD"
  | "COMPLETION_INTENT"
  | "PROOF_DELIVERY";

export type JournalOperationStatus =
  | "QUEUED"
  | "SYNCING"
  | "RETRY_WAIT"
  | "AUTH_BLOCKED"
  | "RETRY_PAUSED"
  | "CONFIRMED"
  | "NEEDS_ACTION"
  | "CANCELLED";

export type JournalVersionPolicy = "REBASABLE_DRAFT" | "PINNED" | "NONE";

export type JournalErrorDisposition =
  | "RETRYABLE"
  | "PERMANENT"
  | "CONFLICT";

export type JournalCommitState = "UNKNOWN" | "NOT_APPLIED" | "APPLIED";

export type JournalRecoveryAction =
  | "RETRY"
  | "REAUTHENTICATE"
  | "REPLACE_ATTACHMENT"
  | "REVIEW_CONFLICT"
  | "REVIEW_OPERATION"
  | "CONTACT_SUPPORT";

export type JournalError = Readonly<{
  code: string;
  message: string;
  disposition: JournalErrorDisposition;
  commitState: JournalCommitState;
  action: JournalRecoveryAction;
  occurredAt: number;
  correlationId?: string;
}>;

export type JournalOperation<TPayload = unknown> = Readonly<{
  storageKey: string;
  scopeKey: string;
  scope: JournalScope;
  id: string;
  sequence: number;
  revision: number;
  kind: JournalOperationKind;
  payload: TPayload;
  dependsOn: readonly string[];
  versionPolicy: JournalVersionPolicy;
  expectedVersion: number | null;
  confirmedBaseVersion: number | null;
  advancesServerVersion: boolean;
  status: JournalOperationStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  confirmedAt: number | null;
  serverReceiptId: string | null;
  serverVersion: number | null;
  lastError: JournalError | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
}>;

export type NewJournalOperation<TPayload = unknown> = Readonly<{
  id: string;
  scope: JournalScope;
  sequence: number;
  kind: JournalOperationKind;
  payload: TPayload;
  dependsOn?: readonly string[];
  versionPolicy?: JournalVersionPolicy;
  expectedVersion?: number | null;
  confirmedBaseVersion?: number | null;
  advancesServerVersion?: boolean;
  createdAt: number;
}>;

export type JournalAttachment = Readonly<{
  storageKey: string;
  scopeKey: string;
  operationId: string;
  blob: Blob;
  fileName: string;
  contentType: string;
  capturedAt: number;
}>;

export type NewJournalAttachment = Readonly<{
  blob: Blob;
  fileName: string;
  contentType: string;
  capturedAt: number;
}>;

export type AppendOrdering = "AFTER_PREVIOUS" | "INDEPENDENT";

export type AppendJournalOperation<TPayload = unknown> = Omit<
  NewJournalOperation<TPayload>,
  "sequence" | "dependsOn"
> &
  Readonly<{
    dependsOn?: readonly string[];
    ordering: AppendOrdering;
    attachment?: NewJournalAttachment;
  }>;

export type JournalClaimInput = Readonly<{
  leaseOwner: string;
  now: number;
  leaseDurationMs?: number;
}>;

type JournalMetadata = {
  scopeKey: string;
  nextSequence: number;
  chainTailOperationId: string | null;
  // Read during the v1 -> v2 transition only.
  lastOperationId?: string | null;
};

export type JournalQuarantineRecord = Readonly<{
  id: string;
  storeName: typeof OPERATIONS_STORE | typeof METADATA_STORE;
  originalKey: IDBValidKey;
  value: unknown;
  reason: string;
  quarantinedAt: number;
}>;

export type JournalOperationMigration =
  | Readonly<{ status: "MIGRATED"; operation: JournalOperation }>
  | Readonly<{ status: "QUARANTINED"; reason: string; value: unknown }>;

type OfflineJournalStoreOptions = {
  databaseName?: string;
  indexedDBFactory?: IDBFactory;
};

// Ninety-six is the strictest current server idempotency-key limit.
const OPERATION_ID_PATTERN = /^[A-Za-z0-9:_-]{8,96}$/;
const LEASE_OWNER_PATTERN = /^[A-Za-z0-9:._-]{8,160}$/;

export function journalScopeKey(scope: JournalScope): string {
  assertScope(scope);
  return JSON.stringify([
    scope.organizationId.trim(),
    scope.actorId.trim().toLowerCase(),
    scope.jobId.trim(),
  ]);
}

export function journalStorageKey(
  scope: JournalScope,
  operationId: string,
): string {
  assertOperationId(operationId);
  return `${journalScopeKey(scope)}\u001f${operationId}`;
}

export function sameJournalScope(
  left: JournalScope,
  right: JournalScope,
): boolean {
  return journalScopeKey(left) === journalScopeKey(right);
}

export function resolveAppendDependencies(input: Readonly<{
  operationId: string;
  explicitDependencies?: readonly string[];
  ordering: AppendOrdering;
  chainTailOperationId: string | null;
}>): Readonly<{
  dependsOn: readonly string[];
  nextChainTailOperationId: string | null;
}> {
  assertOperationId(input.operationId);
  if (
    input.ordering !== "AFTER_PREVIOUS" &&
    input.ordering !== "INDEPENDENT"
  ) {
    throw new Error("Journal append ordering must be explicit.");
  }

  const dependencies = new Set(input.explicitDependencies ?? []);
  for (const dependency of dependencies) {
    assertOperationId(dependency);
    if (dependency === input.operationId) {
      throw new Error("A journal operation cannot depend on itself.");
    }
  }

  if (input.chainTailOperationId !== null) {
    assertOperationId(input.chainTailOperationId);
    if (input.ordering === "AFTER_PREVIOUS") {
      dependencies.add(input.chainTailOperationId);
    }
  }

  return {
    dependsOn: [...dependencies],
    nextChainTailOperationId:
      input.ordering === "AFTER_PREVIOUS"
        ? input.operationId
        : input.chainTailOperationId,
  };
}

export function planBlockedOperationCancellation(
  operations: readonly JournalOperation[],
  targetOperationId: string,
): readonly string[] {
  assertOperationId(targetOperationId);
  const ordered = [...operations].sort(compareJournalOperations);
  const byId = new Map(ordered.map((operation) => [operation.id, operation]));
  const target = byId.get(targetOperationId);
  if (!target) throw new Error("The blocked journal operation was not found.");
  if (
    target.status !== "AUTH_BLOCKED" &&
    target.status !== "NEEDS_ACTION"
  ) {
    throw new Error(
      "Only authentication-blocked or actionable work may be discarded.",
    );
  }
  if (target.lastError?.commitState !== "NOT_APPLIED") {
    throw new Error(
      "Work with an unknown server commit state cannot be safely discarded.",
    );
  }

  const cancellationIds = new Set([target.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const operation of ordered) {
      if (
        cancellationIds.has(operation.id) ||
        !operation.dependsOn.some((dependency) =>
          cancellationIds.has(dependency),
        )
      ) {
        continue;
      }
      cancellationIds.add(operation.id);
      changed = true;
    }
  }

  const cancellation = ordered.filter((operation) =>
    cancellationIds.has(operation.id),
  );
  for (const operation of cancellation) {
    if (operation.status === "CONFIRMED" || operation.status === "SYNCING") {
      throw new Error(
        "A confirmed or in-flight dependent prevents safe cascading discard.",
      );
    }
    if (
      operation.attempts > 0 &&
      operation.lastError?.commitState !== "NOT_APPLIED"
    ) {
      throw new Error(
        "A dependent with an unknown server commit state cannot be discarded.",
      );
    }
  }
  return cancellation.map((operation) => operation.id);
}

export function cancelJournalOperation(
  operation: JournalOperation,
  now: number,
): JournalOperation {
  assertJournalOperation(operation);
  assertTimestamp(now, "now");
  if (operation.status === "CONFIRMED" || operation.status === "SYNCING") {
    throw new Error("Confirmed or in-flight work cannot be discarded.");
  }
  if (
    operation.attempts > 0 &&
    operation.lastError?.commitState !== "NOT_APPLIED"
  ) {
    throw new Error(
      "Work with an unknown server commit state cannot be discarded.",
    );
  }
  if (now < operation.updatedAt) {
    throw new Error("Discarding work cannot move the journal clock backwards.");
  }
  const cancelled: JournalOperation = {
    ...operation,
    revision: operation.revision + 1,
    status: "CANCELLED",
    updatedAt: now,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  assertJournalOperation(cancelled);
  return cancelled;
}

export function createJournalOperation<TPayload>(
  input: NewJournalOperation<TPayload>,
): JournalOperation<TPayload> {
  assertOperationId(input.id);
  assertPositiveInteger(input.sequence, "sequence");
  assertTimestamp(input.createdAt, "createdAt");

  const scopeKey = journalScopeKey(input.scope);
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  for (const dependency of dependsOn) {
    assertOperationId(dependency);
    if (dependency === input.id) {
      throw new Error("A journal operation cannot depend on itself.");
    }
  }

  const versionPolicy =
    input.versionPolicy ??
    (input.kind === "DRAFT_COMMAND" ? "REBASABLE_DRAFT" : "NONE");
  const expectedVersion = input.expectedVersion ?? null;
  const confirmedBaseVersion = input.confirmedBaseVersion ?? null;
  const requiredPolicy: JournalVersionPolicy =
    input.kind === "DRAFT_COMMAND"
      ? "REBASABLE_DRAFT"
      : input.kind === "EVIDENCE_UPLOAD"
        ? "NONE"
        : "PINNED";
  if (versionPolicy !== requiredPolicy) {
    throw new Error(
      `${input.kind} operations require the ${requiredPolicy} version policy.`,
    );
  }
  if (
    versionPolicy !== "NONE" &&
    (!Number.isInteger(expectedVersion) || (expectedVersion ?? -1) < 1)
  ) {
    throw new Error(
      "Versioned journal operations require a positive expectedVersion.",
    );
  }
  if (versionPolicy === "NONE" && expectedVersion !== null) {
    throw new Error(
      "Versionless journal operations cannot declare expectedVersion.",
    );
  }
  if (versionPolicy === "PINNED") {
    if (
      !Number.isInteger(confirmedBaseVersion) ||
      (confirmedBaseVersion ?? -1) < 1 ||
      (expectedVersion !== null &&
        (confirmedBaseVersion ?? expectedVersion) > expectedVersion)
    ) {
      throw new Error(
        "Pinned journal operations require a confirmed base version at or before expectedVersion.",
      );
    }
    if (
      expectedVersion !== confirmedBaseVersion &&
      dependsOn.length === 0
    ) {
      throw new Error(
        "A pinned projected version requires explicit journal dependencies.",
      );
    }
  } else if (confirmedBaseVersion !== null) {
    throw new Error(
      "Only pinned journal operations may declare a confirmed base version.",
    );
  }

  const operation: JournalOperation<TPayload> = {
    storageKey: `${scopeKey}\u001f${input.id}`,
    scopeKey,
    scope: {
      organizationId: input.scope.organizationId.trim(),
      actorId: input.scope.actorId.trim().toLowerCase(),
      jobId: input.scope.jobId.trim(),
    },
    id: input.id,
    sequence: input.sequence,
    revision: 1,
    kind: input.kind,
    payload: input.payload,
    dependsOn,
    versionPolicy,
    expectedVersion,
    confirmedBaseVersion,
    advancesServerVersion: input.advancesServerVersion ?? true,
    status: "QUEUED",
    attempts: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    lastAttemptAt: null,
    nextAttemptAt: null,
    confirmedAt: null,
    serverReceiptId: null,
    serverVersion: null,
    lastError: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  assertJournalOperation(operation);
  return operation;
}

export function migrateJournalOperationRecord(
  value: unknown,
  migrationTime: number,
): JournalOperation {
  assertTimestamp(migrationTime, "migrationTime");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The stored journal operation is not an object.");
  }
  const legacy = value as Partial<JournalOperation>;
  const needsLeaseRecovery =
    legacy.status === "SYNCING" &&
    (legacy.leaseOwner == null || legacy.leaseExpiresAt == null);
  const recoveryTime = Math.max(
    migrationTime,
    typeof legacy.updatedAt === "number" ? legacy.updatedAt : 0,
    typeof legacy.lastAttemptAt === "number" ? legacy.lastAttemptAt : 0,
  );
  const versionPolicy =
    legacy.versionPolicy ??
    (legacy.kind === "DRAFT_COMMAND" ? "REBASABLE_DRAFT" : "NONE");
  const legacyPinnedWithoutBase =
    versionPolicy === "PINNED" &&
    legacy.confirmedBaseVersion == null;
  if (
    legacyPinnedWithoutBase &&
    legacy.status !== "CONFIRMED" &&
    legacy.status !== "CANCELLED" &&
    (legacy.dependsOn?.length ?? 0) > 0
  ) {
    throw new Error(
      "A pending pinned intent from an older journal has no trustworthy confirmed base version.",
    );
  }
  const migrated = {
    ...legacy,
    revision: legacy.revision ?? 1,
    confirmedBaseVersion:
      versionPolicy === "PINNED"
        ? (legacy.confirmedBaseVersion ?? legacy.expectedVersion ?? null)
        : null,
    leaseOwner: needsLeaseRecovery ? null : (legacy.leaseOwner ?? null),
    leaseExpiresAt: needsLeaseRecovery
      ? null
      : (legacy.leaseExpiresAt ?? null),
    ...(needsLeaseRecovery
      ? {
          status: "RETRY_WAIT" as const,
          updatedAt: recoveryTime,
          nextAttemptAt: recoveryTime,
          lastError: {
            code: "JOURNAL_SCHEMA_UPGRADE",
            message:
              "An in-flight operation was recovered after the journal upgrade.",
            disposition: "RETRYABLE" as const,
            commitState: "UNKNOWN" as const,
            action: "RETRY" as const,
            occurredAt: recoveryTime,
          },
        }
      : {}),
  } as JournalOperation;
  assertJournalOperation(migrated);
  return migrated;
}

export function migrateJournalOperationRecordSafely(
  value: unknown,
  migrationTime: number,
): JournalOperationMigration {
  try {
    return {
      status: "MIGRATED",
      operation: migrateJournalOperationRecord(value, migrationTime),
    };
  } catch (error) {
    return {
      status: "QUARANTINED",
      reason:
        error instanceof Error
          ? error.message
          : "The stored journal operation is incompatible.",
      value,
    };
  }
}

export function hasContiguousConfirmedDependencyVersions(
  operation: JournalOperation,
  targetVersion: number,
  confirmedDependencies: readonly JournalOperation[],
): boolean {
  assertJournalOperation(operation);
  if (
    operation.versionPolicy !== "PINNED" ||
    operation.confirmedBaseVersion === null ||
    !Number.isInteger(targetVersion) ||
    targetVersion <= operation.confirmedBaseVersion
  ) {
    return false;
  }

  const confirmedById = new Map(
    confirmedDependencies
      .filter((dependency) => dependency.status === "CONFIRMED")
      .map((dependency) => [dependency.id, dependency] as const),
  );
  if (
    operation.dependsOn.length === 0 ||
    !operation.dependsOn.every((dependencyId) =>
      confirmedById.has(dependencyId),
    )
  ) {
    return false;
  }

  const reachable = new Set<string>();
  const pending = [...operation.dependsOn];
  while (pending.length > 0) {
    const dependencyId = pending.pop()!;
    if (reachable.has(dependencyId)) continue;
    const dependency = confirmedById.get(dependencyId);
    if (!dependency) return false;
    reachable.add(dependencyId);
    pending.push(...dependency.dependsOn);
  }

  const dependencyOwnedVersions = new Set<number>();
  for (const dependencyId of reachable) {
    const dependency = confirmedById.get(dependencyId)!;
    if (
      dependency.advancesServerVersion &&
      dependency.serverVersion !== null &&
      dependency.serverVersion > operation.confirmedBaseVersion &&
      dependency.serverVersion <= targetVersion
    ) {
      dependencyOwnedVersions.add(dependency.serverVersion);
    }
  }
  for (
    let version = operation.confirmedBaseVersion + 1;
    version <= targetVersion;
    version += 1
  ) {
    if (!dependencyOwnedVersions.has(version)) return false;
  }
  return true;
}

export function createJournalClaim(
  persisted: JournalOperation,
  prepared: JournalOperation,
  input: JournalClaimInput,
  confirmedDependencies: readonly JournalOperation[] = [],
): JournalOperation {
  assertJournalOperation(persisted);
  assertJournalOperation(prepared);
  assertLeaseOwner(input.leaseOwner);
  assertTimestamp(input.now, "now");
  const leaseDurationMs =
    input.leaseDurationMs ?? DEFAULT_JOURNAL_LEASE_MS;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs < 1_000) {
    throw new Error("A sync lease must last at least one second.");
  }
  if (
    persisted.storageKey !== prepared.storageKey ||
    persisted.revision !== prepared.revision
  ) {
    throw new Error("The prepared operation is stale.");
  }
  if (
    persisted.status !== "QUEUED" &&
    persisted.status !== "RETRY_WAIT"
  ) {
    throw new Error("Only queued or due retry operations may be claimed.");
  }
  if (
    persisted.status === "RETRY_WAIT" &&
    persisted.nextAttemptAt !== null &&
    persisted.nextAttemptAt > input.now
  ) {
    throw new Error("The operation is not due for retry yet.");
  }
  if (input.now < persisted.updatedAt) {
    throw new Error("A claim cannot move the journal clock backwards.");
  }

  const expectedVersionChanged =
    persisted.expectedVersion !== prepared.expectedVersion;
  const pinnedIntentRequiresDependencyProof =
    persisted.versionPolicy === "PINNED" &&
    persisted.confirmedBaseVersion !== null &&
    prepared.expectedVersion !== null &&
    prepared.expectedVersion > persisted.confirmedBaseVersion;
  const safelyAdvancedPinnedIntent =
    (persisted.kind === "COMPLETION_INTENT" ||
      persisted.kind === "PROOF_DELIVERY") &&
    persisted.versionPolicy === "PINNED" &&
    persisted.attempts === 0 &&
    prepared.expectedVersion !== null &&
    hasContiguousConfirmedDependencyVersions(
      persisted,
      prepared.expectedVersion,
      confirmedDependencies,
    );
  if (
    expectedVersionChanged &&
    !(
      (persisted.kind === "DRAFT_COMMAND" &&
        persisted.versionPolicy === "REBASABLE_DRAFT" &&
        persisted.attempts === 0 &&
        persisted.serverReceiptId === null) ||
      safelyAdvancedPinnedIntent
    )
  ) {
    throw new Error("This operation cannot be safely rebased.");
  }
  if (
    pinnedIntentRequiresDependencyProof &&
    !hasContiguousConfirmedDependencyVersions(
      persisted,
      prepared.expectedVersion!,
      confirmedDependencies,
    )
  ) {
    throw new Error(
      "This pinned operation includes a server version not owned by its confirmed dependencies.",
    );
  }
  if (
    persisted.id !== prepared.id ||
    persisted.kind !== prepared.kind ||
    persisted.sequence !== prepared.sequence ||
    persisted.scopeKey !== prepared.scopeKey ||
    persisted.attempts !== prepared.attempts ||
    persisted.status !== prepared.status
  ) {
    throw new Error("A replay claim cannot change journal identity or state.");
  }

  const claimed: JournalOperation = {
    ...persisted,
    expectedVersion: prepared.expectedVersion,
    confirmedBaseVersion: persisted.confirmedBaseVersion,
    status: "SYNCING",
    attempts: persisted.attempts + 1,
    revision: persisted.revision + 1,
    lastAttemptAt: input.now,
    nextAttemptAt: null,
    updatedAt: input.now,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: input.now + leaseDurationMs,
  };
  assertJournalOperation(claimed);
  return claimed;
}

export function assertJournalClaimResult(
  persistedClaim: JournalOperation,
  result: JournalOperation,
  leaseOwner: string,
): void {
  assertJournalOperation(persistedClaim);
  assertJournalOperation(result);
  assertLeaseOwner(leaseOwner);
  if (
    persistedClaim.status !== "SYNCING" ||
    persistedClaim.leaseOwner !== leaseOwner
  ) {
    throw new Error("The journal claim is not owned by this sync executor.");
  }
  if (
    result.storageKey !== persistedClaim.storageKey ||
    result.revision !== persistedClaim.revision + 1 ||
    result.attempts !== persistedClaim.attempts
  ) {
    throw new Error("The journal result does not advance the claimed revision.");
  }
  if (
    result.status !== "CONFIRMED" &&
    result.status !== "RETRY_WAIT" &&
    result.status !== "AUTH_BLOCKED" &&
    result.status !== "RETRY_PAUSED" &&
    result.status !== "NEEDS_ACTION"
  ) {
    throw new Error("A claim may only finish in a recognized result state.");
  }
  if (result.leaseOwner !== null || result.leaseExpiresAt !== null) {
    throw new Error("A completed claim must release its lease.");
  }
}

export function assertJournalOperation(
  operation: JournalOperation,
): asserts operation is JournalOperation {
  assertOperationId(operation.id);
  assertPositiveInteger(operation.sequence, "sequence");
  assertPositiveInteger(operation.revision, "revision");
  assertTimestamp(operation.createdAt, "createdAt");
  assertTimestamp(operation.updatedAt, "updatedAt");
  if (operation.updatedAt < operation.createdAt) {
    throw new Error("updatedAt cannot be earlier than createdAt.");
  }
  if (operation.scopeKey !== journalScopeKey(operation.scope)) {
    throw new Error("The journal operation scopeKey is inconsistent.");
  }
  if (
    operation.storageKey !== journalStorageKey(operation.scope, operation.id)
  ) {
    throw new Error("The journal operation storageKey is inconsistent.");
  }
  if (!Number.isInteger(operation.attempts) || operation.attempts < 0) {
    throw new Error("attempts must be a non-negative integer.");
  }
  const requiredPolicy: JournalVersionPolicy =
    operation.kind === "DRAFT_COMMAND"
      ? "REBASABLE_DRAFT"
      : operation.kind === "EVIDENCE_UPLOAD"
        ? "NONE"
        : "PINNED";
  if (operation.versionPolicy !== requiredPolicy) {
    throw new Error(
      `${operation.kind} operations require the ${requiredPolicy} version policy.`,
    );
  }
  if (
    operation.versionPolicy !== "NONE" &&
    (!Number.isInteger(operation.expectedVersion) ||
      (operation.expectedVersion ?? -1) < 1)
  ) {
    throw new Error("A versioned operation requires expectedVersion.");
  }
  if (
    operation.versionPolicy === "NONE" &&
    operation.expectedVersion !== null
  ) {
    throw new Error("A versionless operation cannot carry expectedVersion.");
  }
  if (operation.versionPolicy === "PINNED") {
    if (
      operation.confirmedBaseVersion === null ||
      !Number.isInteger(operation.confirmedBaseVersion) ||
      operation.confirmedBaseVersion < 1 ||
      operation.expectedVersion === null ||
      operation.confirmedBaseVersion > operation.expectedVersion
    ) {
      throw new Error(
        "A pinned operation requires a valid confirmed base version.",
      );
    }
    if (
      operation.expectedVersion !== operation.confirmedBaseVersion &&
      operation.dependsOn.length === 0
    ) {
      throw new Error(
        "A pinned projected version requires explicit dependencies.",
      );
    }
  } else if (operation.confirmedBaseVersion !== null) {
    throw new Error(
      "Only pinned operations may carry a confirmed base version.",
    );
  }
  if (new Set(operation.dependsOn).size !== operation.dependsOn.length) {
    throw new Error("Journal dependencies must be unique.");
  }
  for (const dependency of operation.dependsOn) {
    assertOperationId(dependency);
    if (dependency === operation.id) {
      throw new Error("A journal operation cannot depend on itself.");
    }
  }

  if (operation.status === "SYNCING") {
    if (
      operation.attempts < 1 ||
      operation.lastAttemptAt === null ||
      operation.leaseOwner === null ||
      operation.leaseExpiresAt === null
    ) {
      throw new Error(
        "A syncing operation must record its attempt and active lease.",
      );
    }
    assertLeaseOwner(operation.leaseOwner);
    assertTimestamp(operation.leaseExpiresAt, "leaseExpiresAt");
    if (operation.leaseExpiresAt <= operation.lastAttemptAt) {
      throw new Error("A sync lease must expire after its attempt begins.");
    }
  } else if (
    operation.leaseOwner !== null ||
    operation.leaseExpiresAt !== null
  ) {
    throw new Error("Only syncing operations may hold a lease.");
  }

  if (operation.lastAttemptAt !== null) {
    assertTimestamp(operation.lastAttemptAt, "lastAttemptAt");
    if (operation.lastAttemptAt > operation.updatedAt) {
      throw new Error("lastAttemptAt cannot be later than updatedAt.");
    }
  }
  if (operation.status === "RETRY_WAIT") {
    if (
      operation.nextAttemptAt === null ||
      operation.lastError?.disposition !== "RETRYABLE" ||
      operation.lastError.action !== "RETRY"
    ) {
      throw new Error(
        "A retrying operation requires retry timing and a retryable error.",
      );
    }
  }
  if (operation.status === "AUTH_BLOCKED") {
    if (
      operation.nextAttemptAt !== null ||
      operation.lastError?.action !== "REAUTHENTICATE"
    ) {
      throw new Error(
        "An authentication-blocked operation must wait for reauthentication.",
      );
    }
  }
  if (operation.status === "RETRY_PAUSED") {
    if (
      operation.nextAttemptAt !== null ||
      operation.lastError?.disposition !== "RETRYABLE"
    ) {
      throw new Error("A paused retry must remain resumable.");
    }
  }
  if (operation.status === "NEEDS_ACTION") {
    if (
      !operation.lastError ||
      operation.lastError.disposition === "RETRYABLE"
    ) {
      throw new Error(
        "An actionable operation requires a permanent or conflict error.",
      );
    }
  }
  if (operation.status === "CONFIRMED") {
    if (
      operation.confirmedAt === null ||
      operation.serverReceiptId === null ||
      operation.serverVersion === null
    ) {
      throw new Error(
        "A confirmed operation requires its server receipt and version.",
      );
    }
    if (operation.confirmedAt > operation.updatedAt) {
      throw new Error("confirmedAt cannot be later than updatedAt.");
    }
  }
}

export class OfflineJournalStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(
    options: OfflineJournalStoreOptions = {},
  ): Promise<OfflineJournalStore> {
    const factory = options.indexedDBFactory ?? globalThis.indexedDB;
    if (!factory) {
      throw new Error("IndexedDB is unavailable on this device.");
    }
    const database = await openDatabase(
      factory,
      options.databaseName ?? OFFLINE_JOURNAL_DB,
    );
    return new OfflineJournalStore(database);
  }

  close() {
    this.database.close();
  }

  async append<TPayload>(
    input: AppendJournalOperation<TPayload>,
  ): Promise<JournalOperation<TPayload>> {
    validateAttachmentForOperation(input.kind, input.attachment);
    const scopeKey = journalScopeKey(input.scope);
    const transaction = this.database.transaction(
      [OPERATIONS_STORE, ATTACHMENTS_STORE, METADATA_STORE],
      "readwrite",
    );
    const completed = transactionDone(transaction);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    const attachments = transaction.objectStore(ATTACHMENTS_STORE);
    const metadata = transaction.objectStore(METADATA_STORE);

    try {
      const current =
        ((await requestResult(
          metadata.get(scopeKey),
        )) as JournalMetadata | undefined) ?? {
          scopeKey,
          nextSequence: 1,
          chainTailOperationId: null,
        };
      const chainTailOperationId =
        current.chainTailOperationId ?? current.lastOperationId ?? null;
      const dependencyPlan = resolveAppendDependencies({
        operationId: input.id,
        explicitDependencies: input.dependsOn,
        ordering: input.ordering,
        chainTailOperationId,
      });
      const operation = createJournalOperation({
        id: input.id,
        scope: input.scope,
        sequence: current.nextSequence,
        kind: input.kind,
        payload: input.payload,
        dependsOn: dependencyPlan.dependsOn,
        versionPolicy: input.versionPolicy,
        expectedVersion: input.expectedVersion,
        confirmedBaseVersion: input.confirmedBaseVersion,
        advancesServerVersion: input.advancesServerVersion,
        createdAt: input.createdAt,
      });

      operations.add(operation);
      metadata.put({
        scopeKey,
        nextSequence: current.nextSequence + 1,
        chainTailOperationId: dependencyPlan.nextChainTailOperationId,
      } satisfies JournalMetadata);
      if (input.attachment) {
        attachments.add(toJournalAttachment(operation, input.attachment));
      }
      await completed;
      return operation;
    } catch (error) {
      abortQuietly(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async get(
    scope: JournalScope,
    operationId: string,
  ): Promise<JournalOperation | null> {
    const transaction = this.database.transaction(OPERATIONS_STORE, "readonly");
    const completed = transactionDone(transaction);
    const result = (await requestResult(
      transaction
        .objectStore(OPERATIONS_STORE)
        .get(journalStorageKey(scope, operationId)),
    )) as JournalOperation | undefined;
    await completed;
    return result ?? null;
  }

  async getAttachment(
    scope: JournalScope,
    operationId: string,
  ): Promise<JournalAttachment | null> {
    const transaction = this.database.transaction(
      ATTACHMENTS_STORE,
      "readonly",
    );
    const completed = transactionDone(transaction);
    const result = (await requestResult(
      transaction
        .objectStore(ATTACHMENTS_STORE)
        .get(journalStorageKey(scope, operationId)),
    )) as JournalAttachment | undefined;
    await completed;
    return result ?? null;
  }

  async list(scope: JournalScope): Promise<JournalOperation[]> {
    const transaction = this.database.transaction(OPERATIONS_STORE, "readonly");
    const completed = transactionDone(transaction);
    const index = transaction
      .objectStore(OPERATIONS_STORE)
      .index(SCOPE_SEQUENCE_INDEX);
    const range = IDBKeyRange.bound(
      [journalScopeKey(scope), 0],
      [journalScopeKey(scope), Number.MAX_SAFE_INTEGER],
    );
    const result = (await requestResult(
      index.getAll(range),
    )) as JournalOperation[];
    await completed;
    return result.sort(compareJournalOperations);
  }

  async claim(
    prepared: JournalOperation,
    input: JournalClaimInput,
  ): Promise<JournalOperation | null> {
    assertJournalOperation(prepared);
    const transaction = this.database.transaction(OPERATIONS_STORE, "readwrite");
    const completed = transactionDone(transaction);
    const store = transaction.objectStore(OPERATIONS_STORE);
    try {
      const persisted = (await requestResult(
        store.get(prepared.storageKey),
      )) as JournalOperation | undefined;
      if (!persisted || persisted.revision !== prepared.revision) {
        await completed;
        return null;
      }
      const scopeRecords = (await requestResult(
        store
          .index(SCOPE_INDEX)
          .getAll(IDBKeyRange.only(persisted.scopeKey)),
      )) as JournalOperation[];
      const confirmedDependencies = collectConfirmedDependencyClosure(
        persisted,
        scopeRecords,
      );
      const claimed = createJournalClaim(
        persisted,
        prepared,
        input,
        confirmedDependencies,
      );
      store.put(claimed);
      await completed;
      return claimed;
    } catch (error) {
      abortQuietly(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async commitClaim(
    result: JournalOperation,
    input: Readonly<{ expectedRevision: number; leaseOwner: string }>,
  ): Promise<boolean> {
    assertJournalOperation(result);
    assertPositiveInteger(input.expectedRevision, "expectedRevision");
    const transaction = this.database.transaction(
      [OPERATIONS_STORE, ATTACHMENTS_STORE],
      "readwrite",
    );
    const completed = transactionDone(transaction);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    try {
      const persisted = (await requestResult(
        operations.get(result.storageKey),
      )) as JournalOperation | undefined;
      if (!persisted) {
        await completed;
        return false;
      }
      if (
        persisted.status === "CONFIRMED" &&
        result.status === "CONFIRMED" &&
        persisted.serverReceiptId === result.serverReceiptId
      ) {
        await completed;
        return true;
      }
      if (persisted.revision !== input.expectedRevision) {
        await completed;
        return false;
      }
      assertJournalClaimResult(persisted, result, input.leaseOwner);
      operations.put(result);
      if (result.status === "CONFIRMED" && result.kind === "EVIDENCE_UPLOAD") {
        transaction.objectStore(ATTACHMENTS_STORE).delete(result.storageKey);
      }
      await completed;
      return true;
    } catch (error) {
      abortQuietly(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async replaceAttachment(
    scope: JournalScope,
    operationId: string,
    attachment: NewJournalAttachment,
    input: Readonly<{ expectedRevision: number; now: number }>,
  ): Promise<JournalOperation | null> {
    validateAttachment(attachment);
    assertTimestamp(input.now, "now");
    const storageKey = journalStorageKey(scope, operationId);
    const transaction = this.database.transaction(
      [OPERATIONS_STORE, ATTACHMENTS_STORE],
      "readwrite",
    );
    const completed = transactionDone(transaction);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    try {
      const persisted = (await requestResult(
        operations.get(storageKey),
      )) as JournalOperation | undefined;
      if (!persisted || persisted.revision !== input.expectedRevision) {
        await completed;
        return null;
      }
      if (
        persisted.kind !== "EVIDENCE_UPLOAD" ||
        persisted.status !== "NEEDS_ACTION" ||
        persisted.lastError?.action !== "REPLACE_ATTACHMENT" ||
        persisted.lastError.commitState !== "NOT_APPLIED"
      ) {
        throw new Error(
          "Only rejected, unapplied evidence may replace its attachment.",
        );
      }
      if (input.now < persisted.updatedAt) {
        throw new Error("Attachment replacement cannot move time backwards.");
      }
      const requeued: JournalOperation = {
        ...persisted,
        revision: persisted.revision + 1,
        status: "QUEUED",
        updatedAt: input.now,
        nextAttemptAt: null,
        lastError: null,
      };
      assertJournalOperation(requeued);
      operations.put(requeued);
      transaction
        .objectStore(ATTACHMENTS_STORE)
        .put(toJournalAttachment(requeued, attachment));
      await completed;
      return requeued;
    } catch (error) {
      abortQuietly(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async resumeBlocked(
    scope: JournalScope,
    operationId: string,
    input: Readonly<{ expectedRevision: number; now: number }>,
  ): Promise<JournalOperation | null> {
    assertTimestamp(input.now, "now");
    const transaction = this.database.transaction(OPERATIONS_STORE, "readwrite");
    const completed = transactionDone(transaction);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    try {
      const persisted = (await requestResult(
        operations.get(journalStorageKey(scope, operationId)),
      )) as JournalOperation | undefined;
      if (!persisted || persisted.revision !== input.expectedRevision) {
        await completed;
        return null;
      }
      if (
        persisted.status !== "AUTH_BLOCKED" &&
        persisted.status !== "RETRY_PAUSED"
      ) {
        throw new Error(
          "Only authentication-blocked or paused retries may be resumed.",
        );
      }
      if (input.now < persisted.updatedAt) {
        throw new Error("Resuming sync cannot move time backwards.");
      }
      const resumed: JournalOperation = {
        ...persisted,
        revision: persisted.revision + 1,
        status: "QUEUED",
        updatedAt: input.now,
        nextAttemptAt: null,
        lastError: null,
      };
      assertJournalOperation(resumed);
      operations.put(resumed);
      await completed;
      return resumed;
    } catch (error) {
      abortQuietly(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async requireVersionReview(
    scope: JournalScope,
    operationId: string,
    input: Readonly<{ expectedRevision: number; now: number }>,
  ): Promise<JournalOperation | null> {
    assertTimestamp(input.now, "now");
    const transaction = this.database.transaction(OPERATIONS_STORE, "readwrite");
    const completed = transactionDone(transaction);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    try {
      const persisted = (await requestResult(
        operations.get(journalStorageKey(scope, operationId)),
      )) as JournalOperation | undefined;
      if (!persisted || persisted.revision !== input.expectedRevision) {
        await completed;
        return null;
      }
      if (
        persisted.status !== "QUEUED" &&
        persisted.status !== "RETRY_WAIT"
      ) {
        await completed;
        return persisted;
      }
      if (persisted.attempts !== 0) {
        throw new Error(
          "An attempted operation must reconcile with its original idempotent request.",
        );
      }
      const blocked: JournalOperation = {
        ...persisted,
        revision: persisted.revision + 1,
        status: "NEEDS_ACTION",
        updatedAt: Math.max(input.now, persisted.updatedAt),
        nextAttemptAt: null,
        lastError: {
          code: "VERSION_REVIEW_REQUIRED",
          message:
            "The authoritative workflow changed outside this operation's confirmed dependency chain. Review the refreshed state or discard this unapplied intent.",
          disposition: "CONFLICT",
          commitState: "NOT_APPLIED",
          action: "REVIEW_CONFLICT",
          occurredAt: Math.max(input.now, persisted.updatedAt),
        },
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      assertJournalOperation(blocked);
      operations.put(blocked);
      await completed;
      return blocked;
    } catch (error) {
      abortQuietly(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async discardBlockedCascade(
    scope: JournalScope,
    operationId: string,
    input: Readonly<{ expectedRevision: number; now: number }>,
  ): Promise<readonly JournalOperation[] | null> {
    assertTimestamp(input.now, "now");
    const scopeKey = journalScopeKey(scope);
    const transaction = this.database.transaction(
      [OPERATIONS_STORE, METADATA_STORE],
      "readwrite",
    );
    const completed = transactionDone(transaction);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    const metadata = transaction.objectStore(METADATA_STORE);
    try {
      const records = (await requestResult(
        operations
          .index(SCOPE_INDEX)
          .getAll(IDBKeyRange.only(scopeKey)),
      )) as JournalOperation[];
      const target = records.find((operation) => operation.id === operationId);
      if (!target || target.revision !== input.expectedRevision) {
        await completed;
        return null;
      }
      const cancellationIds = new Set(
        planBlockedOperationCancellation(records, operationId),
      );
      const cancelled = records
        .filter((operation) => cancellationIds.has(operation.id))
        .map((operation) => cancelJournalOperation(operation, input.now));
      for (const operation of cancelled) operations.put(operation);

      const currentMetadata = (await requestResult(
        metadata.get(scopeKey),
      )) as JournalMetadata | undefined;
      if (
        currentMetadata?.chainTailOperationId &&
        cancellationIds.has(currentMetadata.chainTailOperationId)
      ) {
        const remainingDrafts = records
          .filter(
            (operation) =>
              operation.kind === "DRAFT_COMMAND" &&
              !cancellationIds.has(operation.id),
          )
          .sort(compareJournalOperations);
        metadata.put({
          ...currentMetadata,
          chainTailOperationId:
            remainingDrafts.at(-1)?.id ?? null,
        } satisfies JournalMetadata);
      }
      await completed;
      return cancelled;
    } catch (error) {
      abortQuietly(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async recoverExpiredLeases(
    scope: JournalScope,
    now: number,
  ): Promise<number> {
    assertTimestamp(now, "now");
    const scopeKey = journalScopeKey(scope);
    const transaction = this.database.transaction(OPERATIONS_STORE, "readwrite");
    const completed = transactionDone(transaction);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    try {
      const records = (await requestResult(
        operations
          .index(SCOPE_INDEX)
          .getAll(IDBKeyRange.only(scopeKey)),
      )) as JournalOperation[];
      let recovered = 0;
      for (const operation of records) {
        if (
          operation.status !== "SYNCING" ||
          operation.leaseExpiresAt === null ||
          operation.leaseExpiresAt > now
        ) {
          continue;
        }
        const next: JournalOperation = {
          ...operation,
          revision: operation.revision + 1,
          status: "RETRY_WAIT",
          updatedAt: now,
          nextAttemptAt: now,
          lastError: {
            code: "SYNC_LEASE_EXPIRED",
            message:
              "The prior result is unknown. Replay will reuse the idempotency key.",
            disposition: "RETRYABLE",
            commitState: "UNKNOWN",
            action: "RETRY",
            occurredAt: now,
          },
          leaseOwner: null,
          leaseExpiresAt: null,
        };
        assertJournalOperation(next);
        operations.put(next);
        recovered += 1;
      }
      await completed;
      return recovered;
    } catch (error) {
      abortQuietly(transaction);
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async clearScope(scope: JournalScope): Promise<void> {
    const scopeKey = journalScopeKey(scope);
    const transaction = this.database.transaction(
      [OPERATIONS_STORE, ATTACHMENTS_STORE, METADATA_STORE],
      "readwrite",
    );
    const completed = transactionDone(transaction);
    await Promise.all([
      deleteIndexEntries(
        transaction.objectStore(OPERATIONS_STORE),
        SCOPE_INDEX,
        scopeKey,
      ),
      deleteIndexEntries(
        transaction.objectStore(ATTACHMENTS_STORE),
        SCOPE_INDEX,
        scopeKey,
      ),
    ]);
    transaction.objectStore(METADATA_STORE).delete(scopeKey);
    await completed;
  }

  async clearActor(scope: ActorScope): Promise<void> {
    const actor = normalizeActorScope(scope);
    const transaction = this.database.transaction(
      [
        OPERATIONS_STORE,
        ATTACHMENTS_STORE,
        METADATA_STORE,
        QUARANTINE_STORE,
      ],
      "readwrite",
    );
    const completed = transactionDone(transaction);
    const operations = transaction.objectStore(OPERATIONS_STORE);
    const attachments = transaction.objectStore(ATTACHMENTS_STORE);
    const metadata = transaction.objectStore(METADATA_STORE);
    const [operationRecords, attachmentRecords, metadataRecords] =
      await Promise.all([
        requestResult(operations.getAll()) as Promise<JournalOperation[]>,
        requestResult(attachments.getAll()) as Promise<JournalAttachment[]>,
        requestResult(metadata.getAll()) as Promise<JournalMetadata[]>,
      ]);
    for (const operation of operationRecords) {
      if (belongsToActor(operation.scope, actor)) {
        operations.delete(operation.storageKey);
      }
    }
    for (const attachment of attachmentRecords) {
      if (scopeKeyBelongsToActor(attachment.scopeKey, actor)) {
        attachments.delete(attachment.storageKey);
      }
    }
    for (const record of metadataRecords) {
      if (scopeKeyBelongsToActor(record.scopeKey, actor)) {
        metadata.delete(record.scopeKey);
      }
    }
    // Incompatible legacy records cannot be safely attributed to an actor.
    // Clearing the quarantine prevents them crossing an identity boundary.
    transaction.objectStore(QUARANTINE_STORE).clear();
    await completed;
  }

  async clearAll(): Promise<void> {
    const transaction = this.database.transaction(
      [
        OPERATIONS_STORE,
        ATTACHMENTS_STORE,
        METADATA_STORE,
        QUARANTINE_STORE,
      ],
      "readwrite",
    );
    const completed = transactionDone(transaction);
    transaction.objectStore(OPERATIONS_STORE).clear();
    transaction.objectStore(ATTACHMENTS_STORE).clear();
    transaction.objectStore(METADATA_STORE).clear();
    transaction.objectStore(QUARANTINE_STORE).clear();
    await completed;
  }
}

export function compareJournalOperations(
  left: JournalOperation,
  right: JournalOperation,
) {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function validateAttachmentForOperation(
  kind: JournalOperationKind,
  attachment?: NewJournalAttachment,
) {
  if (kind === "EVIDENCE_UPLOAD" && !attachment) {
    throw new Error("Evidence uploads require a durable attachment.");
  }
  if (kind !== "EVIDENCE_UPLOAD" && attachment) {
    throw new Error("Only evidence uploads may store an attachment.");
  }
  if (attachment) validateAttachment(attachment);
}

function validateAttachment(attachment: NewJournalAttachment) {
  if (!(attachment.blob instanceof Blob)) {
    throw new Error("A journal attachment must be a Blob.");
  }
  if (
    attachment.blob.size < 1 ||
    attachment.blob.size > MAX_ATTACHMENT_BYTES
  ) {
    throw new Error("Evidence must be between 1 byte and 10 MiB.");
  }
  if (
    !attachment.contentType.trim() ||
    (attachment.blob.type &&
      attachment.blob.type.toLowerCase() !==
        attachment.contentType.trim().toLowerCase())
  ) {
    throw new Error("Attachment content type does not match its Blob.");
  }
  if (
    !attachment.fileName.trim() ||
    attachment.fileName.length > 255 ||
    /[/\\\0]/.test(attachment.fileName)
  ) {
    throw new Error("Attachment fileName is invalid.");
  }
  assertTimestamp(attachment.capturedAt, "capturedAt");
}

function toJournalAttachment(
  operation: JournalOperation,
  attachment: NewJournalAttachment,
): JournalAttachment {
  validateAttachment(attachment);
  return {
    storageKey: operation.storageKey,
    scopeKey: operation.scopeKey,
    operationId: operation.id,
    blob: attachment.blob,
    fileName: attachment.fileName.trim(),
    contentType: attachment.contentType.trim().toLowerCase(),
    capturedAt: attachment.capturedAt,
  };
}

function assertScope(scope: JournalScope) {
  assertScopedValue(scope.organizationId, "organizationId");
  assertScopedValue(scope.actorId, "actorId");
  assertScopedValue(scope.jobId, "jobId");
}

function normalizeActorScope(scope: ActorScope): ActorScope {
  assertScopedValue(scope.organizationId, "organizationId");
  assertScopedValue(scope.actorId, "actorId");
  return {
    organizationId: scope.organizationId.trim(),
    actorId: scope.actorId.trim().toLowerCase(),
  };
}

function belongsToActor(scope: JournalScope, actor: ActorScope) {
  return (
    scope.organizationId === actor.organizationId &&
    scope.actorId.toLowerCase() === actor.actorId
  );
}

function scopeKeyBelongsToActor(scopeKey: string, actor: ActorScope) {
  try {
    const parsed = JSON.parse(scopeKey);
    return (
      Array.isArray(parsed) &&
      parsed[0] === actor.organizationId &&
      typeof parsed[1] === "string" &&
      parsed[1].toLowerCase() === actor.actorId
    );
  } catch {
    return false;
  }
}

function assertScopedValue(value: string, name: string) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > 320
  ) {
    throw new Error(`${name} must be a non-empty scoped identifier.`);
  }
}

function assertOperationId(value: string) {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new Error("Journal operation ids must be stable opaque identifiers.");
  }
}

function assertLeaseOwner(value: string) {
  if (!LEASE_OWNER_PATTERN.test(value)) {
    throw new Error("A lease owner must be a stable opaque identifier.");
  }
}

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertTimestamp(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative timestamp.`);
  }
}

function openDatabase(factory: IDBFactory, databaseName: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, OFFLINE_JOURNAL_DB_VERSION);
    let settled = false;
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OPERATIONS_STORE)) {
        const operations = database.createObjectStore(OPERATIONS_STORE, {
          keyPath: "storageKey",
        });
        operations.createIndex(
          SCOPE_SEQUENCE_INDEX,
          ["scopeKey", "sequence"],
          { unique: true },
        );
        operations.createIndex(SCOPE_INDEX, "scopeKey");
      }
      if (!database.objectStoreNames.contains(ATTACHMENTS_STORE)) {
        const attachments = database.createObjectStore(ATTACHMENTS_STORE, {
          keyPath: "storageKey",
        });
        attachments.createIndex(SCOPE_INDEX, "scopeKey");
      }
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, { keyPath: "scopeKey" });
      }
      if (!database.objectStoreNames.contains(QUARANTINE_STORE)) {
        database.createObjectStore(QUARANTINE_STORE, { keyPath: "id" });
      }
      if (event.oldVersion < OFFLINE_JOURNAL_DB_VERSION && request.transaction) {
        migrateVersionOneRecords(request.transaction, Date.now());
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(
        request.error ?? new Error("The offline journal could not open."),
      );
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          "The offline journal upgrade is blocked by another FieldProof tab.",
        ),
      );
    };
  });
}

function migrateVersionOneRecords(
  transaction: IDBTransaction,
  migrationTime: number,
) {
  const operations = transaction.objectStore(OPERATIONS_STORE);
  const quarantine = transaction.objectStore(QUARANTINE_STORE);
  const operationCursor = operations.openCursor();
  operationCursor.onsuccess = () => {
    const cursor = operationCursor.result;
    if (!cursor) return;
    const migration = migrateJournalOperationRecordSafely(
      cursor.value,
      migrationTime,
    );
    if (migration.status === "MIGRATED") {
      cursor.update(migration.operation);
    } else {
      quarantine.put(
        createQuarantineRecord(
          OPERATIONS_STORE,
          cursor.primaryKey,
          migration.value,
          migration.reason,
          migrationTime,
        ),
      );
      cursor.delete();
    }
    cursor.continue();
  };

  const metadata = transaction.objectStore(METADATA_STORE);
  const metadataCursor = metadata.openCursor();
  metadataCursor.onsuccess = () => {
    const cursor = metadataCursor.result;
    if (!cursor) return;
    try {
      const record = migrateJournalMetadataRecord(cursor.value);
      cursor.update(record);
    } catch (error) {
      quarantine.put(
        createQuarantineRecord(
          METADATA_STORE,
          cursor.primaryKey,
          cursor.value,
          error instanceof Error
            ? error.message
            : "The stored journal metadata is incompatible.",
          migrationTime,
        ),
      );
      cursor.delete();
    }
    cursor.continue();
  };
}

function collectConfirmedDependencyClosure(
  operation: JournalOperation,
  records: readonly JournalOperation[],
) {
  const byId = new Map(records.map((record) => [record.id, record] as const));
  const confirmed: JournalOperation[] = [];
  const visited = new Set<string>();
  const pending = [...operation.dependsOn];
  while (pending.length > 0) {
    const dependencyId = pending.pop()!;
    if (visited.has(dependencyId)) continue;
    visited.add(dependencyId);
    const dependency = byId.get(dependencyId);
    if (!dependency || dependency.status !== "CONFIRMED") continue;
    confirmed.push(dependency);
    pending.push(...dependency.dependsOn);
  }
  return confirmed;
}

function migrateJournalMetadataRecord(value: unknown): JournalMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The stored journal metadata is not an object.");
  }
  const record = value as Partial<JournalMetadata>;
  if (typeof record.scopeKey !== "string" || !record.scopeKey.trim()) {
    throw new Error("The stored journal metadata has no scope key.");
  }
  assertPositiveInteger(record.nextSequence ?? 0, "nextSequence");
  const chainTailOperationId =
    record.chainTailOperationId ?? record.lastOperationId ?? null;
  if (chainTailOperationId !== null) {
    assertOperationId(chainTailOperationId);
  }
  return {
    scopeKey: record.scopeKey,
    nextSequence: record.nextSequence!,
    chainTailOperationId,
  };
}

function createQuarantineRecord(
  storeName: JournalQuarantineRecord["storeName"],
  originalKey: IDBValidKey,
  value: unknown,
  reason: string,
  migrationTime: number,
): JournalQuarantineRecord {
  return {
    id: `${storeName}:${migrationTime}:${stableKey(originalKey)}`,
    storeName,
    originalKey,
    value,
    reason,
    quarantinedAt: migrationTime,
  };
}

function stableKey(value: IDBValidKey) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value instanceof ArrayBuffer) {
    return [...new Uint8Array(value)].join(".");
  }
  if (ArrayBuffer.isView(value)) {
    return [...new Uint8Array(value.buffer)].join(".");
  }
  return String(value);
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("The offline journal request failed."));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new Error("The offline journal transaction failed."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("The offline journal transaction aborted."),
      );
  });
}

function abortQuietly(transaction: IDBTransaction) {
  try {
    transaction.abort();
  } catch {
    // Preserve the originating IndexedDB error.
  }
}

async function deleteIndexEntries(
  store: IDBObjectStore,
  indexName: string,
  scopeKey: string,
) {
  const index = store.index(indexName);
  const keys = await requestResult(index.getAllKeys(IDBKeyRange.only(scopeKey)));
  for (const key of keys) store.delete(key);
}
