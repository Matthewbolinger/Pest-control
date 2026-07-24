/// <reference types="node" />

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  assertJournalClaimResult,
  assertJournalOperation,
  cancelJournalOperation,
  createJournalClaim,
  createJournalOperation,
  DEFAULT_JOURNAL_LEASE_MS,
  hasContiguousConfirmedDependencyVersions,
  journalScopeKey,
  migrateJournalOperationRecord,
  migrateJournalOperationRecordSafely,
  OfflineJournalStore,
  planBlockedOperationCancellation,
  resolveAppendDependencies,
  sameJournalScope,
  type JournalOperation,
  type JournalScope,
} from "../packages/client/offline-store";
import {
  classifySyncFailure,
  confirmSyncOperation,
  createFieldProofHttpTransport,
  DEFAULT_SYNC_REQUEST_TIMEOUT_MS,
  markSyncAttempt,
  OfflineSyncExecutor,
  planJournalReplay,
  recordSyncFailure,
  recoverInterruptedSync,
  resumeBlockedOperation,
  retryDelayMs,
} from "../packages/client/sync-engine";

const NOW = 1_721_822_400_000;
const SCOPE: JournalScope = {
  organizationId: "ORG-NORTHSTAR",
  actorId: "Tech@Northstar.Example",
  jobId: "JOB-2048",
};

describe("offline journal identity and invariants", () => {
  it("creates a canonical tenant, actor, and job scope key", () => {
    expect(journalScopeKey(SCOPE)).toBe(
      '["ORG-NORTHSTAR","tech@northstar.example","JOB-2048"]',
    );
    expect(
      sameJournalScope(SCOPE, {
        ...SCOPE,
        actorId: "tech@northstar.example",
      }),
    ).toBe(true);
    expect(
      sameJournalScope(SCOPE, {
        ...SCOPE,
        jobId: "JOB-OTHER",
      }),
    ).toBe(false);
  });

  it("creates a queued draft with durable revision and retry metadata", () => {
    const operation = draft("command-checklist-0001", 1, 5);
    expect(operation).toMatchObject({
      scope: {
        organizationId: "ORG-NORTHSTAR",
        actorId: "tech@northstar.example",
        jobId: "JOB-2048",
      },
      status: "QUEUED",
      revision: 1,
      attempts: 0,
      expectedVersion: 5,
      versionPolicy: "REBASABLE_DRAFT",
      nextAttemptAt: null,
      lastError: null,
      leaseOwner: null,
    });
    expect(() => assertJournalOperation(operation)).not.toThrow();
  });

  it("rejects self-dependencies and rebase policies on non-drafts", () => {
    expect(() =>
      createJournalOperation({
        id: "command-self-0001",
        scope: SCOPE,
        sequence: 1,
        kind: "DRAFT_COMMAND",
        payload: {},
        dependsOn: ["command-self-0001"],
        versionPolicy: "REBASABLE_DRAFT",
        expectedVersion: 1,
        createdAt: NOW,
      }),
    ).toThrow("cannot depend on itself");

    expect(() =>
      createJournalOperation({
        id: "evidence-upload-0001",
        scope: SCOPE,
        sequence: 1,
        kind: "EVIDENCE_UPLOAD",
        payload: {},
        versionPolicy: "REBASABLE_DRAFT",
        expectedVersion: 1,
        createdAt: NOW,
      }),
    ).toThrow("require the NONE version policy");

    expect(() =>
      createJournalOperation({
        id: "completion-intent-0001",
        scope: SCOPE,
        sequence: 1,
        kind: "COMPLETION_INTENT",
        payload: { type: "COMPLETE_JOB" },
        versionPolicy: "PINNED",
        expectedVersion: 5,
        createdAt: NOW,
      }),
    ).toThrow("confirmed base version");
  });

  it("migrates v1 records and recovers unknown in-flight work", () => {
    const queuedLegacy = {
      ...draft("command-checklist-0001", 1, 5),
    } as Partial<JournalOperation> & Record<string, unknown>;
    Reflect.deleteProperty(queuedLegacy, "revision");
    Reflect.deleteProperty(queuedLegacy, "leaseOwner");
    Reflect.deleteProperty(queuedLegacy, "leaseExpiresAt");
    expect(
      migrateJournalOperationRecord(queuedLegacy, NOW + 10),
    ).toMatchObject({
      revision: 1,
      status: "QUEUED",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    const syncingLegacy = {
      ...markSyncAttempt(draft("command-checklist-0002", 2, 5), NOW),
    } as Partial<JournalOperation> & Record<string, unknown>;
    Reflect.deleteProperty(syncingLegacy, "revision");
    Reflect.deleteProperty(syncingLegacy, "leaseOwner");
    Reflect.deleteProperty(syncingLegacy, "leaseExpiresAt");
    expect(
      migrateJournalOperationRecord(syncingLegacy, NOW + 10),
    ).toMatchObject({
      revision: 1,
      status: "RETRY_WAIT",
      nextAttemptAt: NOW + 10,
      lastError: {
        code: "JOURNAL_SCHEMA_UPGRADE",
        commitState: "UNKNOWN",
      },
    });
  });

  it("quarantines an incompatible v1 record instead of throwing", () => {
    expect(
      migrateJournalOperationRecordSafely(
        {
          storageKey: "broken",
          status: "QUEUED",
          payload: { private: "preserved for support review" },
        },
        NOW,
      ),
    ).toEqual({
      status: "QUARANTINED",
      reason: expect.any(String),
      value: {
        storageKey: "broken",
        status: "QUEUED",
        payload: { private: "preserved for support review" },
      },
    });
  });

  it("quarantines a legacy projected intent whose confirmed base is unknowable", () => {
    const legacy = {
      ...pinned(
        "completion-intent-0001",
        2,
        6,
        ["command-checklist-0001"],
        5,
      ),
    } as Partial<JournalOperation> & Record<string, unknown>;
    Reflect.deleteProperty(legacy, "confirmedBaseVersion");

    expect(migrateJournalOperationRecordSafely(legacy, NOW + 1)).toEqual({
      status: "QUARANTINED",
      reason: expect.stringContaining("no trustworthy confirmed base"),
      value: legacy,
    });
  });

  it("keeps independent work from replacing the ordered chain tail", () => {
    const chained = resolveAppendDependencies({
      operationId: "command-checklist-0002",
      explicitDependencies: ["evidence-upload-0001"],
      ordering: "AFTER_PREVIOUS",
      chainTailOperationId: "command-checklist-0001",
    });
    expect(chained).toEqual({
      dependsOn: ["evidence-upload-0001", "command-checklist-0001"],
      nextChainTailOperationId: "command-checklist-0002",
    });

    const independent = resolveAppendDependencies({
      operationId: "evidence-upload-0002",
      ordering: "INDEPENDENT",
      chainTailOperationId: chained.nextChainTailOperationId,
    });
    expect(independent).toEqual({
      dependsOn: [],
      nextChainTailOperationId: "command-checklist-0002",
    });

    const nextChained = resolveAppendDependencies({
      operationId: "completion-intent-0003",
      ordering: "AFTER_PREVIOUS",
      chainTailOperationId: independent.nextChainTailOperationId,
    });
    expect(nextChained.dependsOn).toEqual(["command-checklist-0002"]);
  });

  it("deduplicates append dependencies and rejects an explicit self edge", () => {
    expect(
      resolveAppendDependencies({
        operationId: "command-checklist-0002",
        explicitDependencies: [
          "command-checklist-0001",
          "command-checklist-0001",
        ],
        ordering: "AFTER_PREVIOUS",
        chainTailOperationId: "command-checklist-0001",
      }).dependsOn,
    ).toEqual(["command-checklist-0001"]);
    expect(() =>
      resolveAppendDependencies({
        operationId: "command-checklist-0001",
        explicitDependencies: ["command-checklist-0001"],
        ordering: "INDEPENDENT",
        chainTailOperationId: null,
      }),
    ).toThrow("cannot depend on itself");
  });

  it("cascades discard only through unapplied dependent work", () => {
    const target = recordSyncFailure(
      markSyncAttempt(draft("command-checklist-0001", 1, 5), NOW),
      classifySyncFailure({ status: 401 }, NOW + 1),
      NOW + 1,
    );
    const dependent = draft(
      "command-observation-0002",
      2,
      6,
      [target.id],
    );

    expect(
      planBlockedOperationCancellation([target, dependent], target.id),
    ).toEqual([target.id, dependent.id]);
    expect(
      [target, dependent].map((operation) =>
        cancelJournalOperation(operation, NOW + 2),
      ),
    ).toEqual([
      expect.objectContaining({ id: target.id, status: "CANCELLED" }),
      expect.objectContaining({ id: dependent.id, status: "CANCELLED" }),
    ]);
  });

  it("refuses to discard a dependent with unknown server commit state", () => {
    const target = recordSyncFailure(
      markSyncAttempt(draft("command-checklist-0001", 1, 5), NOW),
      classifySyncFailure({ status: 401 }, NOW + 1),
      NOW + 1,
    );
    const dependent = recordSyncFailure(
      markSyncAttempt(
        draft("command-observation-0002", 2, 6, [target.id]),
        NOW + 2,
      ),
      classifySyncFailure({ status: 503 }, NOW + 3),
      NOW + 3,
    );

    expect(() =>
      planBlockedOperationCancellation([target, dependent], target.id),
    ).toThrow("unknown server commit state");
  });

  it("claims by revision and validates the lease-owned result", () => {
    const persisted = draft("command-checklist-0001", 1, 5);
    const claimed = createJournalClaim(persisted, persisted, {
      leaseOwner: "tab:test-owner-0001",
      now: NOW + 1,
      leaseDurationMs: 5_000,
    });
    const confirmed = confirmSyncOperation(claimed, {
      receiptId: "receipt-confirmed-0001",
      serverVersion: 6,
      confirmedAt: NOW + 2,
    });

    expect(claimed).toMatchObject({
      revision: 2,
      status: "SYNCING",
      attempts: 1,
      leaseOwner: "tab:test-owner-0001",
      leaseExpiresAt: NOW + 5_001,
    });
    expect(() =>
      assertJournalClaimResult(
        claimed,
        confirmed,
        "tab:test-owner-0001",
      ),
    ).not.toThrow();
    expect(() =>
      assertJournalClaimResult(
        claimed,
        confirmed,
        "tab:different-owner",
      ),
    ).toThrow("not owned");
  });

  it("fails explicitly when IndexedDB is unavailable", async () => {
    await expect(
      OfflineJournalStore.open({ indexedDBFactory: undefined }),
    ).rejects.toThrow("IndexedDB is unavailable");
  });
});

describe("dependency-aware serial replay planning", () => {
  it("exposes only evidence, then completion after evidence confirmation", () => {
    const evidence = versionless("evidence-upload-0001", 2);
    const completion = pinned(
      "completion-intent-0001",
      1,
      6,
      ["evidence-upload-0001"],
      5,
    );
    const firstPlan = planJournalReplay({
      scope: SCOPE,
      operations: [completion, evidence],
      serverVersion: 5,
      now: NOW,
    });

    expect(firstPlan.executionMode).toBe(
      "SERIAL_REPLAN_AFTER_CONFIRMATION",
    );
    expect(firstPlan.ready.map((item) => item.operation.id)).toEqual([
      "evidence-upload-0001",
    ]);
    expect(firstPlan.projectedServerVersion).toBe(6);
    expect(firstPlan.blocked).toContainEqual(
      expect.objectContaining({
        operationId: "completion-intent-0001",
        dependencyId: "evidence-upload-0001",
        reason: "WAITING_FOR_DEPENDENCY",
      }),
    );

    const confirmedEvidence = confirmSyncOperation(
      markSyncAttempt(evidence, NOW + 1),
      {
        receiptId: "receipt-evidence-0001",
        serverVersion: 6,
        confirmedAt: NOW + 2,
      },
    );
    const secondPlan = planJournalReplay({
      scope: SCOPE,
      operations: [completion, confirmedEvidence],
      serverVersion: 6,
      now: NOW + 3,
    });
    expect(secondPlan.ready.map((item) => item.operation.id)).toEqual([
      "completion-intent-0001",
    ]);
    expect(secondPlan.ready[0]?.expectedVersion).toBe(6);
    expect(secondPlan.projectedServerVersion).toBe(7);
  });

  it("rebases one unattempted draft, confirms, then replans the next", () => {
    const first = draft("command-checklist-0001", 1, 4);
    const second = draft(
      "command-observation-0002",
      2,
      5,
      ["command-checklist-0001"],
    );
    const firstPlan = planJournalReplay({
      scope: SCOPE,
      operations: [first, second],
      serverVersion: 10,
      now: NOW + 10,
    });

    expect(firstPlan.ready).toHaveLength(1);
    expect(firstPlan.ready[0]?.expectedVersion).toBe(10);
    expect(firstPlan.ready[0]?.operation.updatedAt).toBe(NOW + 10);
    expect(first.expectedVersion).toBe(4);
    expect(firstPlan.projectedServerVersion).toBe(11);

    const preparedFirst = firstPlan.ready[0]?.operation;
    expect(preparedFirst).toBeDefined();
    const confirmedFirst = confirmSyncOperation(
      markSyncAttempt(preparedFirst!, NOW + 11),
      {
        receiptId: "receipt-command-0001",
        serverVersion: 11,
        confirmedAt: NOW + 12,
      },
    );
    const secondPlan = planJournalReplay({
      scope: SCOPE,
      operations: [confirmedFirst, second],
      serverVersion: 11,
      now: NOW + 13,
    });
    expect(secondPlan.ready).toHaveLength(1);
    expect(secondPlan.ready[0]?.operation.id).toBe(
      "command-observation-0002",
    );
    expect(secondPlan.ready[0]?.expectedVersion).toBe(11);
  });

  it("never rebases a pinned completion intent", () => {
    const completion = pinned("completion-intent-0001", 1, 5);
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [completion],
      serverVersion: 8,
      now: NOW,
    });

    expect(plan.ready).toEqual([]);
    expect(plan.blocked).toEqual([
      expect.objectContaining({
        operationId: "completion-intent-0001",
        reason: "VERSION_REVIEW_REQUIRED",
      }),
    ]);
  });

  it("aligns an unattempted pinned intent only to confirmed dependencies", () => {
    const evidence = versionless("evidence-upload-0001", 1);
    const confirmedEvidence = confirmSyncOperation(
      markSyncAttempt(evidence, NOW),
      {
        receiptId: "receipt-evidence-0001",
        serverVersion: 6,
        confirmedAt: NOW + 1,
      },
    );
    const completion = pinned(
      "completion-intent-0001",
      2,
      5,
      [evidence.id],
    );
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [confirmedEvidence, completion],
      serverVersion: 6,
      now: NOW + 2,
    });
    const prepared = plan.ready[0]?.operation;
    expect(prepared).toMatchObject({
      id: completion.id,
      expectedVersion: 6,
    });
    expect(
      createJournalClaim(
        completion,
        prepared!,
        {
          leaseOwner: "tab:test-owner-0001",
          now: NOW + 3,
        },
        [confirmedEvidence],
      ),
    ).toMatchObject({
      status: "SYNCING",
      expectedVersion: 6,
    });
    expect(
      planJournalReplay({
        scope: SCOPE,
        operations: [completion],
        serverVersion: 6,
        now: NOW + 2,
      }).ready,
    ).toEqual([]);
  });

  it("rejects pinned alignment when an external version interrupts the dependency chain", () => {
    const confirmedSix = confirmSyncOperation(
      markSyncAttempt(versionless("evidence-upload-0001", 1), NOW),
      {
        receiptId: "receipt-version-0006",
        serverVersion: 6,
        confirmedAt: NOW + 1,
      },
    );
    const confirmedEight = confirmSyncOperation(
      markSyncAttempt(
        draft(
          "command-checklist-0002",
          2,
          7,
          [confirmedSix.id],
        ),
        NOW + 2,
      ),
      {
        receiptId: "receipt-version-0008",
        serverVersion: 8,
        confirmedAt: NOW + 3,
      },
    );
    const completion = pinned(
      "completion-intent-0001",
      3,
      5,
      [confirmedEight.id],
    );

    expect(
      hasContiguousConfirmedDependencyVersions(completion, 8, [
        confirmedSix,
        confirmedEight,
      ]),
    ).toBe(false);
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [confirmedSix, confirmedEight, completion],
      serverVersion: 8,
      now: NOW + 4,
    });
    expect(plan.ready).toEqual([]);
    expect(plan.blocked).toContainEqual(
      expect.objectContaining({
        operationId: completion.id,
        reason: "VERSION_REVIEW_REQUIRED",
      }),
    );
    expect(() =>
      createJournalClaim(
        completion,
        { ...completion, expectedVersion: 8 },
        {
          leaseOwner: "tab:test-owner-0001",
          now: NOW + 4,
        },
        [confirmedSix, confirmedEight],
      ),
    ).toThrow("cannot be safely rebased");
  });

  it("rejects an optimistic pinned slot occupied by an unrelated external edit", () => {
    const localDraft = draft("command-checklist-0001", 1, 5);
    const confirmedDraft = confirmSyncOperation(
      markSyncAttempt(
        { ...localDraft, expectedVersion: 6 },
        NOW + 1,
      ),
      {
        receiptId: "receipt-command-0001",
        serverVersion: 7,
        confirmedAt: NOW + 2,
      },
    );
    const completion = pinned(
      "completion-intent-0001",
      2,
      6,
      [localDraft.id],
      5,
    );

    expect(
      hasContiguousConfirmedDependencyVersions(completion, 7, [
        confirmedDraft,
      ]),
    ).toBe(false);
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [confirmedDraft, completion],
      serverVersion: 7,
      now: NOW + 3,
    });
    expect(plan.ready).toEqual([]);
    expect(plan.blocked).toContainEqual(
      expect.objectContaining({
        operationId: completion.id,
        reason: "VERSION_REVIEW_REQUIRED",
      }),
    );
    expect(() =>
      createJournalClaim(
        completion,
        completion,
        {
          leaseOwner: "tab:test-owner-0001",
          now: NOW + 4,
        },
        [confirmedDraft],
      ),
    ).toThrow("not owned by its confirmed dependencies");
  });

  it("replays the exact draft body after an ambiguous transport attempt", () => {
    const attempted = markSyncAttempt(
      draft("command-checklist-0001", 1, 5),
      NOW + 1,
    );
    const retryable = recordSyncFailure(
      attempted,
      classifySyncFailure(
        { status: 503, message: "Connection dropped." },
        NOW + 2,
      ),
      NOW + 2,
    );
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [{ ...retryable, nextAttemptAt: NOW }],
      serverVersion: 8,
      now: NOW + 3,
    });

    expect(plan.ready).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({
          id: retryable.id,
          expectedVersion: 5,
          attempts: 1,
        }),
      }),
    ]);
    expect(plan.blocked).toEqual([]);
    expect(retryable.expectedVersion).toBe(5);
  });

  it("resumes a pinned completion with its exact reviewed version", () => {
    const evidence = confirmSyncOperation(
      markSyncAttempt(versionless("evidence-upload-0001", 1), NOW),
      {
        receiptId: "receipt-evidence-0001",
        serverVersion: 6,
        confirmedAt: NOW + 1,
      },
    );
    const attempted = markSyncAttempt(
      pinned(
        "completion-intent-0001",
        2,
        6,
        [evidence.id],
        5,
      ),
      NOW + 2,
    );
    const resumed = resumeBlockedOperation(
      recordSyncFailure(
        attempted,
        classifySyncFailure({ status: 401 }, NOW + 3),
        NOW + 3,
      ),
      NOW + 4,
    );
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [evidence, resumed],
      serverVersion: 7,
      now: NOW + 5,
    });

    expect(plan.ready[0]?.operation).toMatchObject({
      id: resumed.id,
      expectedVersion: 6,
      confirmedBaseVersion: 5,
      attempts: 1,
    });
  });

  it("defers retries until their deterministic retry time", () => {
    const attempted = markSyncAttempt(
      draft("command-checklist-0001", 1, 5),
      NOW,
    );
    const waiting = recordSyncFailure(
      attempted,
      classifySyncFailure({ status: 503 }, NOW + 1),
      NOW + 1,
    );
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [waiting],
      serverVersion: 5,
      now: NOW + 500,
    });

    expect(plan.ready).toEqual([]);
    expect(plan.deferred).toEqual([
      {
        operationId: "command-checklist-0001",
        retryAt: NOW + 1 + retryDelayMs(1),
      },
    ]);
  });

  it("blocks dependents of actionable failures but continues independent work", () => {
    const evidence = markSyncAttempt(
      versionless("evidence-upload-0001", 1),
      NOW,
    );
    const failedEvidence = recordSyncFailure(
      evidence,
      classifySyncFailure(
        {
          status: 400,
          code: "INVALID_EVIDENCE",
          message: "Unsupported bytes.",
        },
        NOW + 1,
      ),
      NOW + 1,
    );
    const completion = pinned(
      "completion-intent-0001",
      2,
      6,
      ["evidence-upload-0001"],
      5,
    );
    const independent = draft("command-checklist-0002", 3, 5);
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [failedEvidence, completion, independent],
      serverVersion: 5,
      now: NOW + 2,
    });

    expect(plan.ready.map((item) => item.operation.id)).toEqual([
      "command-checklist-0002",
    ]);
    expect(plan.blocked).toContainEqual(
      expect.objectContaining({
        operationId: "completion-intent-0001",
        dependencyId: "evidence-upload-0001",
        reason: "DEPENDENCY_NEEDS_ACTION",
      }),
    );
  });

  it("reports missing dependencies and cycles instead of guessing", () => {
    const missing = draft(
      "command-observation-0001",
      1,
      5,
      ["command-missing-0000"],
    );
    const cycleA = draft(
      "command-cycle-a001",
      2,
      5,
      ["command-cycle-b001"],
    );
    const cycleB = draft(
      "command-cycle-b001",
      3,
      6,
      ["command-cycle-a001"],
    );
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [missing, cycleA, cycleB],
      serverVersion: 5,
      now: NOW,
    });

    expect(plan.blocked).toContainEqual(
      expect.objectContaining({
        operationId: "command-observation-0001",
        reason: "MISSING_DEPENDENCY",
      }),
    );
    expect(
      plan.blocked.filter((item) => item.reason === "DEPENDENCY_CYCLE"),
    ).toHaveLength(2);
  });

  it("serializes the entire scope while one operation holds a lease", () => {
    const syncing = markSyncAttempt(
      draft("command-checklist-0001", 1, 5),
      NOW,
    );
    const independent = draft("command-checklist-0002", 2, 5);
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [syncing, independent],
      serverVersion: 5,
      now: NOW + 1,
    });
    expect(plan.ready).toEqual([]);
    expect(plan.blocked).toContainEqual(
      expect.objectContaining({ reason: "IN_FLIGHT" }),
    );
    expect(plan.blocked).toContainEqual(
      expect.objectContaining({
        operationId: "command-checklist-0002",
        reason: "WAITING_FOR_DEPENDENCY",
      }),
    );
  });

  it("refuses to replay operations across scopes", () => {
    const other = {
      ...draft("command-checklist-0001", 1, 5),
      scope: { ...SCOPE, jobId: "JOB-OTHER" },
    };
    expect(() =>
      planJournalReplay({
        scope: SCOPE,
        operations: [other],
        serverVersion: 5,
        now: NOW,
      }),
    ).toThrow();
  });
});

describe("sync lifecycle metadata", () => {
  it("keeps request timeout below the cross-tab journal lease", () => {
    expect(DEFAULT_SYNC_REQUEST_TIMEOUT_MS).toBeLessThan(
      DEFAULT_JOURNAL_LEASE_MS,
    );
    expect(
      () =>
        new OfflineSyncExecutor(
          {} as OfflineJournalStore,
          { send: vi.fn() },
          {
            requestTimeoutMs: 30_000,
            leaseDurationMs: 30_000,
          },
        ),
    ).toThrow("must be longer");
  });

  it("records attempts, retry timing, leases, and unknown commit state", () => {
    const syncing = markSyncAttempt(
      draft("command-checklist-0001", 1, 5),
      NOW,
    );
    const error = classifySyncFailure(
      { status: 503, code: "WORKFLOW_UNAVAILABLE" },
      NOW + 1,
    );
    const waiting = recordSyncFailure(syncing, error, NOW + 1);

    expect(syncing).toMatchObject({
      status: "SYNCING",
      revision: 2,
      attempts: 1,
      lastAttemptAt: NOW,
      leaseOwner: "local-sync-lease",
    });
    expect(waiting).toMatchObject({
      status: "RETRY_WAIT",
      revision: 3,
      nextAttemptAt: NOW + 1 + 1_000,
      leaseOwner: null,
      lastError: {
        disposition: "RETRYABLE",
        commitState: "UNKNOWN",
        action: "RETRY",
      },
    });
  });

  it("turns invalid evidence into an actionable replacement task", () => {
    const syncing = markSyncAttempt(
      versionless("evidence-upload-0001", 1),
      NOW,
    );
    const failed = recordSyncFailure(
      syncing,
      classifySyncFailure(
        { status: 400, code: "INVALID_EVIDENCE" },
        NOW + 1,
      ),
      NOW + 1,
    );

    expect(failed).toMatchObject({
      status: "NEEDS_ACTION",
      nextAttemptAt: null,
      lastError: {
        disposition: "PERMANENT",
        commitState: "NOT_APPLIED",
        action: "REPLACE_ATTACHMENT",
      },
    });
  });

  it("pauses authentication failures and explicitly resumes them", () => {
    const syncing = markSyncAttempt(
      draft("command-checklist-0001", 1, 5),
      NOW,
    );
    const blocked = recordSyncFailure(
      syncing,
      classifySyncFailure({ status: 401 }, NOW + 1),
      NOW + 1,
    );
    const plan = planJournalReplay({
      scope: SCOPE,
      operations: [blocked],
      serverVersion: 5,
      now: NOW + 2,
    });
    const resumed = resumeBlockedOperation(blocked, NOW + 3);

    expect(blocked).toMatchObject({
      status: "AUTH_BLOCKED",
      lastError: {
        disposition: "RETRYABLE",
        action: "REAUTHENTICATE",
        commitState: "NOT_APPLIED",
      },
    });
    expect(plan.blocked).toContainEqual(
      expect.objectContaining({ reason: "AUTHENTICATION_REQUIRED" }),
    );
    expect(resumed).toMatchObject({
      status: "QUEUED",
      revision: blocked.revision + 1,
      lastError: null,
    });
  });

  it("treats forbidden access as permanent rather than an auth loop", () => {
    expect(classifySyncFailure({ status: 403 }, NOW)).toMatchObject({
      disposition: "PERMANENT",
      action: "REVIEW_OPERATION",
      commitState: "NOT_APPLIED",
    });
  });

  it("requires an active claim for confirmation and failure", () => {
    const queued = draft("command-checklist-0001", 1, 5);
    expect(() =>
      confirmSyncOperation(queued, {
        receiptId: "receipt-confirmed-0001",
        serverVersion: 6,
        confirmedAt: NOW + 1,
      }),
    ).toThrow("actively syncing");
    expect(() =>
      recordSyncFailure(
        queued,
        classifySyncFailure({ status: 503 }, NOW + 1),
        NOW + 1,
      ),
    ).toThrow("actively syncing");
  });

  it("records authoritative confirmation receipts", () => {
    const syncing = markSyncAttempt(
      draft("command-checklist-0001", 1, 5),
      NOW,
    );
    const confirmed = confirmSyncOperation(syncing, {
      receiptId: "WCR-confirmed-0001",
      serverVersion: 6,
      confirmedAt: NOW + 10,
    });

    expect(confirmed).toMatchObject({
      status: "CONFIRMED",
      revision: 3,
      serverReceiptId: "WCR-confirmed-0001",
      serverVersion: 6,
      confirmedAt: NOW + 10,
      lastError: null,
      leaseOwner: null,
    });
  });

  it("recovers an expired in-flight lease without changing identity", () => {
    const syncing = markSyncAttempt(
      draft("command-checklist-0001", 1, 5),
      NOW,
    );
    const unchanged = recoverInterruptedSync(
      syncing,
      NOW + DEFAULT_JOURNAL_LEASE_MS - 1,
    );
    const recovered = recoverInterruptedSync(
      syncing,
      NOW + DEFAULT_JOURNAL_LEASE_MS,
    );

    expect(unchanged).toBe(syncing);
    expect(recovered).toMatchObject({
      id: syncing.id,
      revision: syncing.revision + 1,
      status: "RETRY_WAIT",
      nextAttemptAt: NOW + DEFAULT_JOURNAL_LEASE_MS,
      leaseOwner: null,
      lastError: {
        code: "CLIENT_RESTART",
        commitState: "UNKNOWN",
      },
    });
  });

  it("caps delay and pauses rather than permanently poisoning an outage", () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(20)).toBe(300_000);

    let operation = draft("command-checklist-0001", 1, 5);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      operation = markSyncAttempt(operation, NOW + attempt * 2);
      operation = recordSyncFailure(
        operation,
        classifySyncFailure({ status: 503 }, NOW + attempt * 2 + 1),
        NOW + attempt * 2 + 1,
      );
      if (operation.status === "RETRY_WAIT") {
        operation = { ...operation, nextAttemptAt: NOW };
      }
    }
    expect(operation).toMatchObject({
      status: "RETRY_PAUSED",
      attempts: 8,
      lastError: {
        disposition: "RETRYABLE",
        action: "CONTACT_SUPPORT",
      },
    });
    expect(resumeBlockedOperation(operation, NOW + 20).status).toBe("QUEUED");
  });
});

describe("production HTTP replay transport", () => {
  it("sends workflow commands with the operation id and prepared version", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        "idempotency-key": "command-checklist-0001",
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        type: "SET_CHECKLIST_STEP",
        commandId: "command-checklist-0001",
        expectedVersion: 5,
      });
      return Response.json({
        data: { version: 6 },
        correlationId: "corr-workflow-0001",
      });
    });
    const transport = createFieldProofHttpTransport(fetchMock);
    const syncing = markSyncAttempt(
      draft("command-checklist-0001", 1, 5),
      NOW,
    );

    await expect(
      transport.send({ operation: syncing, attachment: null }),
    ).resolves.toEqual({
      receiptId: "corr-workflow-0001",
      serverVersion: 6,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/workflow",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
  });
});

describe("cache-safe PWA shell", () => {
  it("declares a scoped standalone manifest", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../public/manifest.webmanifest", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "FieldProof",
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(manifest.icons).toEqual([
      expect.objectContaining({
        src: "/favicon.svg",
        purpose: "any maskable",
      }),
    ]);
  });

  it("keeps APIs network-only and arbitrary private images outside the cache", async () => {
    const harness = createServiceWorkerHarness();
    const api = harness.dispatchFetch({
      method: "GET",
      url: "https://fieldproof.test/api/v1/workflow",
      mode: "cors",
      destination: "",
    });
    await api.response;
    expect(harness.fetchCalls).toHaveLength(1);
    expect(harness.fetchCalls[0]?.init).toMatchObject({ cache: "no-store" });
    expect(harness.cacheOpenCalls).toBe(0);

    const privateImage = harness.dispatchFetch({
      method: "GET",
      url: "https://fieldproof.test/assets/private-evidence.jpg",
      mode: "cors",
      destination: "image",
    });
    expect(privateImage.intercepted).toBe(false);
  });

  it("returns only a tenant-neutral offline page for failed navigation", async () => {
    const harness = createServiceWorkerHarness({ rejectFetch: true });
    const navigation = harness.dispatchFetch({
      method: "GET",
      url: "https://fieldproof.test/jobs/JOB-2048",
      mode: "navigate",
      destination: "document",
    });
    const response = await navigation.response;
    expect(response?.status).toBe(503);
    expect(await response?.text()).toContain("securely return");
    expect(harness.cacheMatchKeys).not.toContain("/");
  });

  it("pre-caches only public assets and never fetches authenticated root HTML", async () => {
    const harness = createServiceWorkerHarness();
    await harness.dispatchActivate();
    expect(harness.deletedCacheKeys).toContain("fieldproof-shell-v1");
    await harness.dispatchInstall();
    expect(harness.precached).toEqual([
      "/manifest.webmanifest",
      "/favicon.svg",
    ]);
    await harness.dispatchMessage({
      type: "FIELDPROOF_SET_BUILD",
      buildSha: "build-safe-0001",
    });
    expect(harness.fetchCalls).toEqual([]);
    expect(harness.precached).not.toContain("/");
  });

  it("rejects unverified build provenance instead of caching it", async () => {
    const harness = createServiceWorkerHarness();
    await expect(
      harness.dispatchMessage({
        type: "FIELDPROOF_SET_BUILD",
        buildSha: "unverified",
      }),
    ).rejects.toThrow("verified source revision");
    expect(harness.workerMessages).toContainEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("blocks an auth transition when private database clearing fails", async () => {
    const harness = createServiceWorkerHarness({
      indexedDbOpenFails: true,
    });
    const signOut = harness.dispatchFetch({
      method: "GET",
      url: "https://fieldproof.test/signout-with-chatgpt",
      mode: "navigate",
      destination: "document",
    });
    const response = await signOut.response;
    expect(response?.status).toBe(503);
    expect(await response?.text()).toContain("Sign-in transition paused");
    expect(harness.fetchCalls).toEqual([]);
  });
});

describe("release provenance gate", () => {
  it("accepts only the exact checked-out commit and rejects a mismatch", () => {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const script = new URL(
      "../scripts/verify-release-provenance.mjs",
      import.meta.url,
    );
    const accepted = spawnSync(
      process.execPath,
      [fileURLToPath(script), "--allow-dirty"],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, FIELDPROOF_BUILD_SHA: headSha },
      },
    );
    const rejected = spawnSync(
      process.execPath,
      [fileURLToPath(script), "--allow-dirty"],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          FIELDPROOF_BUILD_SHA: "0".repeat(40),
        },
      },
    );

    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain(headSha);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("does not match HEAD");
  });
});

function draft(
  id: string,
  sequence: number,
  expectedVersion: number,
  dependsOn: readonly string[] = [],
): JournalOperation {
  return createJournalOperation({
    id,
    scope: SCOPE,
    sequence,
    kind: "DRAFT_COMMAND",
    payload: { type: "SET_CHECKLIST_STEP", index: 0, complete: true },
    dependsOn,
    versionPolicy: "REBASABLE_DRAFT",
    expectedVersion,
    createdAt: NOW,
  });
}

function pinned(
  id: string,
  sequence: number,
  expectedVersion: number,
  dependsOn: readonly string[] = [],
  confirmedBaseVersion = expectedVersion,
): JournalOperation {
  return createJournalOperation({
    id,
    scope: SCOPE,
    sequence,
    kind: "COMPLETION_INTENT",
    payload: { type: "COMPLETE_JOB" },
    dependsOn,
    versionPolicy: "PINNED",
    expectedVersion,
    confirmedBaseVersion,
    createdAt: NOW,
  });
}

function versionless(id: string, sequence: number): JournalOperation {
  return createJournalOperation({
    id,
    scope: SCOPE,
    sequence,
    kind: "EVIDENCE_UPLOAD",
    payload: {
      propertyId: "PROPERTY-0001",
      zoneId: "ZONE-0001",
      phase: "AFTER",
      subject: "Treatment result",
    },
    versionPolicy: "NONE",
    expectedVersion: null,
    createdAt: NOW,
  });
}

type WorkerRequest = Readonly<{
  method: string;
  url: string;
  mode: string;
  destination: string;
}>;

function createServiceWorkerHarness(
  options: Readonly<{
    rejectFetch?: boolean;
    indexedDbOpenFails?: boolean;
  }> = {},
) {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetchCalls: Array<{
    input: RequestInfo | URL;
    init?: RequestInit;
  }> = [];
  const cacheMatchKeys: string[] = [];
  const precached: string[] = [];
  const deletedCacheKeys: string[] = [];
  const workerMessages: unknown[] = [];
  let cacheOpenCalls = 0;
  const cacheValues = new Map<string, Response>();

  const cache = {
    async addAll(assets: readonly string[]) {
      precached.push(...assets);
    },
    async match(input: RequestInfo | URL) {
      const key = typeof input === "string" ? input : String(input);
      cacheMatchKeys.push(key);
      return cacheValues.get(key);
    },
    async put(input: RequestInfo | URL, response: Response) {
      const key = typeof input === "string" ? input : String(input);
      cacheValues.set(key, response);
    },
  };
  const cachesMock = {
    async open() {
      cacheOpenCalls += 1;
      return cache;
    },
    async keys() {
      return ["fieldproof-public-shell-v2", "fieldproof-shell-v1"];
    },
    async delete(key: string) {
      deletedCacheKeys.push(key);
      cacheValues.clear();
      return true;
    },
  };
  const fetchMock = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    fetchCalls.push({ input, ...(init ? { init } : {}) });
    if (options.rejectFetch) throw new TypeError("offline");
    return new Response("network", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  const workerSelf = {
    location: { origin: "https://fieldproof.test" },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, handler);
    },
    ...(options.indexedDbOpenFails
      ? {
          indexedDB: {
            open() {
              const request: {
                error: Error | null;
                onerror: (() => void) | null;
              } = {
                error: null,
                onerror: null,
              };
              queueMicrotask(() => {
                request.error = new Error("IndexedDB privacy failure");
                request.onerror?.();
              });
              return request;
            },
          },
        }
      : {}),
  };
  const source = readFileSync(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );
  runInNewContext(source, {
    self: workerSelf,
    caches: cachesMock,
    fetch: fetchMock,
    URL,
    Response,
    Error,
    Set,
    Promise,
    Array,
    setTimeout,
    clearTimeout,
  });

  return {
    fetchCalls,
    cacheMatchKeys,
    precached,
    deletedCacheKeys,
    workerMessages,
    get cacheOpenCalls() {
      return cacheOpenCalls;
    },
    dispatchFetch(request: WorkerRequest) {
      let response: Promise<Response> | undefined;
      listeners.get("fetch")?.({
        request,
        respondWith(value: Response | Promise<Response>) {
          response = Promise.resolve(value);
        },
      });
      return {
        intercepted: Boolean(response),
        response: response ?? Promise.resolve(undefined),
      };
    },
    async dispatchInstall() {
      let completion: Promise<unknown> = Promise.resolve();
      listeners.get("install")?.({
        waitUntil(value: Promise<unknown>) {
          completion = value;
        },
      });
      await completion;
    },
    async dispatchActivate() {
      let completion: Promise<unknown> = Promise.resolve();
      listeners.get("activate")?.({
        waitUntil(value: Promise<unknown>) {
          completion = value;
        },
      });
      await completion;
    },
    async dispatchMessage(data: Record<string, unknown>) {
      let completion: Promise<unknown> = Promise.resolve();
      listeners.get("message")?.({
        data,
        ports: [
          {
            postMessage(message: unknown) {
              workerMessages.push(message);
            },
          },
        ],
        waitUntil(value: Promise<unknown>) {
          completion = value;
        },
      });
      await completion;
    },
  };
}
