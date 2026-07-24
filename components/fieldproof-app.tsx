"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { huntleyCandidates } from "@/packages/domain";
import { applyWorkflowCommand } from "@/packages/application/workflow";
import type {
  EvidenceRecord,
  WorkflowCommand,
  WorkflowSnapshot,
} from "@/packages/application/workflow";
import {
  OfflineJournalStore,
  type JournalOperation,
  type JournalScope,
} from "@/packages/client/offline-store";
import {
  createFieldProofHttpTransport,
  OfflineSyncExecutor,
  type ReplayExecutionResult,
} from "@/packages/client/sync-engine";

type View =
  | "control"
  | "requests"
  | "schedule"
  | "jobs"
  | "properties"
  | "exceptions"
  | "playbooks"
  | "analytics"
  | "audit"
  | "settings"
  | "technician"
  | "proof";

type SyncKind = "loading" | "synced" | "pending" | "offline" | "error";

type SyncState = {
  kind: SyncKind;
  message: string;
};

type AuditItem = {
  id: string;
  actor_type: "AI" | "HUMAN" | "SYSTEM";
  action: string;
  occurred_at: number;
  reason: string;
  policy_version?: string | null;
};

type OperationsData = {
  identity?: {
    userId?: string;
    displayName?: string;
    email?: string;
    role?: string;
    technicianId?: string | null;
  };
  organization?: {
    id?: string;
    name?: string;
    autonomy_level?: string;
  } | null;
  customer?: {
    name?: string;
    email?: string | null;
    phone?: string | null;
  } | null;
  property?: {
    address?: string;
    property_type?: string;
    recurring_plan_status?: string;
  } | null;
  serviceRequest?: {
    description?: string;
    received_at?: number | null;
  } | null;
  appointment?: {
    id?: string;
    technician_id?: string;
    starts_at?: number;
    duration_minutes?: number;
    status?: string;
  } | null;
  playbook?: {
    version_label?: string;
    required_evidence_json?: string;
  } | null;
  economics?: Array<{
    phase?: string;
    contribution_margin_cents?: number;
    revenue_cents?: number;
    actual_reservice_cost_cents?: number;
  }>;
  outcome?: {
    status?: string;
    technician_assessment?: string;
    observation_window_ends_at?: number | null;
    verified_at?: number | null;
    verification_source?: string | null;
  } | null;
  outcomeCheckpoints?: Array<{
    id?: string;
    status?: string;
    due_at?: number;
    result?: string | null;
  }>;
  proofDeliveries?: Array<{
    id?: string;
    status?: string;
    provider_message_id?: string | null;
    delivered_at?: number | null;
  }>;
  integration?: {
    connection?: {
      provider?: string;
      mode?: string;
      status?: string;
      last_successful_sync_at?: number | null;
    } | null;
    syncs?: Array<{
      id?: string;
      status?: string;
      source_count?: number;
      reconciled_count?: number;
      started_at?: number;
    }>;
  };
};

const navigation: {
  id: View;
  label: string;
  mark: string;
  enabled: boolean;
}[] = [
  { id: "control", label: "Control Tower", mark: "CT", enabled: true },
  { id: "schedule", label: "Schedule", mark: "SC", enabled: true },
  { id: "requests", label: "Service Requests", mark: "SR", enabled: true },
  { id: "jobs", label: "Jobs", mark: "JB", enabled: true },
  { id: "properties", label: "Properties", mark: "PR", enabled: true },
  { id: "exceptions", label: "Exceptions", mark: "EX", enabled: true },
  { id: "playbooks", label: "Playbooks", mark: "PB", enabled: true },
  { id: "analytics", label: "Outcomes", mark: "AN", enabled: true },
  { id: "audit", label: "Audit", mark: "AU", enabled: true },
  { id: "settings", label: "Integrations", mark: "IN", enabled: true },
];

const checklistLabels = [
  "Inspect basement perimeter and sill plates",
  "Inspect utility penetrations and accessible voids",
  "Document signs, conditions, and potential entry points",
  "Review unresolved risks and follow-up requirement",
];

export function FieldProofApp() {
  const [view, setView] = useState<View>("control");
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [operations, setOperations] = useState<OperationsData | null>(null);
  const [sync, setSync] = useState<SyncState>({
    kind: "loading",
    message: "Loading authoritative workflow…",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedCandidateDraft, setSelectedCandidateDraft] = useState(
    huntleyCandidates[0].id,
  );
  const [offlineReady, setOfflineReady] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [blockedJournalOperations, setBlockedJournalOperations] = useState<
    JournalOperation[]
  >([]);
  const [onlineTick, setOnlineTick] = useState(0);
  const [confirmedVersion, setConfirmedVersion] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const snapshotRef = useRef<WorkflowSnapshot | null>(null);
  const confirmedSnapshotRef = useRef<WorkflowSnapshot | null>(null);
  const syncingRef = useRef(false);
  const journalStoreRef = useRef<OfflineJournalStore | null>(null);
  const journalExecutorRef = useRef<OfflineSyncExecutor | null>(null);
  const journalScopeRef = useRef<JournalScope | null>(null);
  const journalInitializationRef = useRef<
    Promise<JournalOperation[]> | null
  >(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (
      !operations?.identity?.userId ||
      !operations.organization?.id
    ) {
      return;
    }
    journalScopeRef.current = {
      organizationId: operations.organization.id,
      actorId: operations.identity.userId,
      jobId: "JOB-2048",
    };
  }, [operations]);

  useEffect(() => {
    function onPwaStatus(event: Event) {
      const status = (
        event as CustomEvent<{ status?: string }>
      ).detail?.status;
      setOfflineReady(status === "ready");
    }
    window.addEventListener("fieldproof:pwa-status", onPwaStatus);
    return () =>
      window.removeEventListener("fieldproof:pwa-status", onPwaStatus);
  }, []);

  const refreshAudit = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/audit", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { data?: AuditItem[] };
      if (Array.isArray(body.data)) setAudit(body.data);
    } catch {
      // The workflow remains usable when the secondary audit read is unavailable.
    }
  }, []);

  const refreshOperations = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/operations", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = (await response.json()) as { data?: OperationsData };
      if (body.data) setOperations(body.data);
    } catch {
      // Operational projections are additive; the workflow remains usable.
    }
  }, []);

  const refreshWorkflow = useCallback(
    async (quiet = false) => {
      if (!quiet) {
        setSync({ kind: "loading", message: "Refreshing server workflow…" });
      }
      try {
        const response = await fetch("/api/v1/workflow", {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        const body = (await response.json().catch(() => null)) as
          | { data?: WorkflowSnapshot; error?: { message?: string } }
          | null;
        if (!response.ok || !body?.data) {
          throw new Error(body?.error?.message ?? "Workflow could not be loaded.");
        }
        setSnapshot(body.data);
        snapshotRef.current = body.data;
        confirmedSnapshotRef.current = body.data;
        setConfirmedVersion(body.data.version);
        setSelectedCandidateDraft(
          body.data.selectedCandidateId ?? huntleyCandidates[0].id,
        );
        setSync({
          kind: "synced",
          message: `Server confirmed · workflow v${body.data.version}`,
        });
        void refreshAudit();
        void refreshOperations();
        return body.data;
      } catch (error) {
        const cached = snapshotRef.current;
        const confirmed = confirmedSnapshotRef.current;
        const hasDraft = Boolean(
          cached && confirmed && cached.version !== confirmed.version,
        );
        setSync({
          kind: navigator.onLine ? "error" : "offline",
          message: cached
            ? hasDraft
              ? "Showing saved field draft · awaiting server confirmation"
              : "Showing last server-confirmed snapshot · offline"
            : errorMessage(error),
        });
        return null;
      }
    },
    [refreshAudit, refreshOperations],
  );

  const reflectJournalOperations = useCallback(
    (operations: readonly JournalOperation[]) => {
      setPendingCount(countJournalPending(operations));
      setBlockedJournalOperations(
        operations.filter(isRecoverableJournalOperation),
      );
    },
    [],
  );

  const initializeJournal = useCallback(async () => {
    if (
      journalStoreRef.current &&
      journalExecutorRef.current &&
      journalScopeRef.current
    ) {
      return journalStoreRef.current.list(journalScopeRef.current);
    }
    if (journalInitializationRef.current) {
      return journalInitializationRef.current;
    }
    const initialization = (async () => {
      const response = await fetch("/api/v1/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as
        | {
            data?: {
              user?: { id?: string };
              membership?: { organizationId?: string };
            };
          }
        | null;
      const organizationId = body?.data?.membership?.organizationId;
      const actorId = body?.data?.user?.id;
      if (!response.ok || !organizationId || !actorId) {
        throw new Error(
          "The offline journal could not resolve its actor scope.",
        );
      }
      const scope: JournalScope = {
        organizationId,
        actorId,
        jobId: "JOB-2048",
      };
      const store = await OfflineJournalStore.open();
      journalScopeRef.current = scope;
      journalStoreRef.current = store;
      journalExecutorRef.current = new OfflineSyncExecutor(
        store,
        createFieldProofHttpTransport(),
      );
      setOfflineReady(true);
      return store.list(scope);
    })();
    journalInitializationRef.current = initialization;
    try {
      return await initialization;
    } catch (error) {
      journalInitializationRef.current = null;
      throw error;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const journalOperations = await initializeJournal();
        if (cancelled) return;
        reflectJournalOperations(journalOperations);
        await refreshWorkflow();
        if (countJournalPending(journalOperations) > 0 && navigator.onLine) {
          setOnlineTick((value) => value + 1);
        }
      } catch {
        setOfflineReady(false);
        await refreshWorkflow();
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [initializeJournal, reflectJournalOperations, refreshWorkflow]);

  useEffect(() => {
    function onOnline() {
      setOnlineTick((value) => value + 1);
    }
    function onOffline() {
      setSync({
        kind: "offline",
        message: "Offline · new work will be held on this device",
      });
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  const dispatchCommand = useCallback(
    async (command: WorkflowCommand): Promise<WorkflowSnapshot | null> => {
      const journalStore = journalStoreRef.current;
      const journalExecutor = journalExecutorRef.current;
      const journalScope = journalScopeRef.current;
      if (
        journalStore &&
        journalExecutor &&
        journalScope &&
        isJournaledCommand(command)
      ) {
        setBusy(command.type);
        setSync({
          kind: "pending",
          message: `${commandLabel(command.type)} · saved locally first`,
        });
        try {
          const existing = await journalStore.list(journalScope);
          const dependencies =
            command.type === "COMPLETE_JOB" ||
            command.type === "SEND_PROOF"
              ? activeJournalOperations(existing).map((item) => item.id)
              : [];
          await journalStore.append({
            id: command.commandId,
            scope: journalScope,
            kind: journalKind(command),
            payload: offlineCommandPayload(command),
            dependsOn: dependencies,
            ordering: isDraftOnlyCommand(command)
              ? "AFTER_PREVIOUS"
              : "INDEPENDENT",
            versionPolicy: isDraftOnlyCommand(command)
              ? "REBASABLE_DRAFT"
              : "PINNED",
            expectedVersion: command.expectedVersion,
            confirmedBaseVersion: isDraftOnlyCommand(command)
              ? null
              : requireConfirmedBaseVersion(confirmedSnapshotRef.current),
            advancesServerVersion: true,
            createdAt: Date.now(),
          });

          const current = snapshotRef.current;
          if (current && isDraftOnlyCommand(command)) {
            try {
              const draft = applyWorkflowCommand(current, command);
              setSnapshot(draft);
              snapshotRef.current = draft;
            } catch {
              // The server remains authoritative when a local transition is invalid.
            }
          }
          reflectJournalOperations(await journalStore.list(journalScope));
          if (!navigator.onLine) {
            setSync({
              kind: "offline",
              message:
                "Change is durable on this device · awaiting server confirmation",
            });
            return null;
          }

          const replay = await replayJournalOperation(
            journalStore,
            journalExecutor,
            journalScope,
            command.commandId,
            confirmedSnapshotRef.current?.version ??
              command.expectedVersion,
          );
          const confirmed = await refreshWorkflow(true);
          reflectJournalOperations(await journalStore.list(journalScope));
          if (replay.operation?.status !== "CONFIRMED") {
            setSync({
              kind:
                replay.result?.stoppedBecause === "DEFERRED"
                  ? "pending"
                  : "error",
              message: journalResultMessage(
                replay.result?.stoppedBecause ?? "BLOCKED",
              ),
            });
            return null;
          }
          return confirmed;
        } catch (error) {
          setSync({
            kind: navigator.onLine ? "error" : "offline",
            message: errorMessage(error),
          });
          return null;
        } finally {
          setBusy(null);
        }
      }

      setBusy(command.type);
      setSync({ kind: "pending", message: `${commandLabel(command.type)}…` });
      try {
        const response = await fetch("/api/v1/workflow", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "Idempotency-Key": command.commandId,
            ...(command.type === "VERIFY_OUTCOME"
              ? { "x-fieldproof-demo-persona": "MANAGER" }
              : {}),
          },
          body: JSON.stringify(command),
        });
        const body = (await response.json().catch(() => null)) as
          | {
              data?: WorkflowSnapshot;
              error?: { code?: string; message?: string };
            }
          | null;
        if (response.status === 409) {
          await refreshWorkflow(true);
          setSync({
            kind: "error",
            message:
              body?.error?.message ??
              "The workflow changed elsewhere. Review the refreshed state and try again.",
          });
          return null;
        }
        if (!response.ok || !body?.data) {
          throw new ResponseError(
            response.status,
            body?.error?.message ?? "The server rejected this change.",
          );
        }
        setSnapshot(body.data);
        snapshotRef.current = body.data;
        confirmedSnapshotRef.current = body.data;
        setConfirmedVersion(body.data.version);
        if (journalStore && journalScope) {
          reflectJournalOperations(await journalStore.list(journalScope));
        } else {
          reflectJournalOperations([]);
        }
        setSync({
          kind: "synced",
          message: `Server confirmed · workflow v${body.data.version}`,
        });
        void refreshAudit();
        void refreshOperations();
        return body.data;
      } catch (error) {
        if (error instanceof ResponseError && error.status < 500) {
          setSync({ kind: "error", message: error.message });
          return null;
        }
        setSync({
          kind: navigator.onLine ? "error" : "offline",
          message: journalStore
            ? "The server did not confirm this action; retry from the refreshed state."
            : "Durable offline storage is unavailable on this device; reconnect and retry.",
        });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [
      reflectJournalOperations,
      refreshAudit,
      refreshOperations,
      refreshWorkflow,
    ],
  );

  const uploadEvidence = useCallback(
    async (
      file: File,
      semantics: {
        phase: EvidenceRecord["phase"];
        subject: EvidenceRecord["subject"];
        caption: string;
        capturedAt: number;
      },
      idempotencyKey = crypto.randomUUID(),
    ): Promise<WorkflowSnapshot | null> => {
      setBusy("UPLOAD_EVIDENCE");
      setSync({
        kind: "pending",
        message: "Saving evidence locally before upload…",
      });
      const journalStore = journalStoreRef.current;
      const journalExecutor = journalExecutorRef.current;
      const journalScope = journalScopeRef.current;
      if (journalStore && journalExecutor && journalScope) {
        try {
          await journalStore.append({
            id: idempotencyKey,
            scope: journalScope,
            kind: "EVIDENCE_UPLOAD",
            payload: {
              propertyId: "PROP-118",
              zoneId: "ZONE-BASEMENT",
              phase: semantics.phase,
              subject: semantics.subject,
              caption: semantics.caption,
            },
            ordering: "INDEPENDENT",
            versionPolicy: "NONE",
            expectedVersion: null,
            confirmedBaseVersion: null,
            advancesServerVersion: true,
            createdAt: semantics.capturedAt,
            attachment: {
              blob: file,
              fileName: file.name,
              contentType: file.type,
              capturedAt: semantics.capturedAt,
            },
          });
          reflectJournalOperations(await journalStore.list(journalScope));
          if (!navigator.onLine) {
            setSync({
              kind: "offline",
              message:
                "Evidence is durable on this device · it is not counted until the server confirms it",
            });
            return null;
          }
          const replay = await replayJournalOperation(
            journalStore,
            journalExecutor,
            journalScope,
            idempotencyKey,
            confirmedSnapshotRef.current?.version ??
              snapshotRef.current?.version ??
              1,
          );
          const confirmed = await refreshWorkflow(true);
          if (replay.operation?.status === "CONFIRMED") {
            reflectJournalOperations(await journalStore.list(journalScope));
            return confirmed;
          }
          setSync({
            kind:
              replay.result?.stoppedBecause === "DEFERRED"
                ? "pending"
                : "error",
            message: journalResultMessage(
              replay.result?.stoppedBecause ?? "BLOCKED",
            ),
          });
          return null;
        } catch (error) {
          setSync({
            kind: navigator.onLine ? "error" : "offline",
            message: errorMessage(error),
          });
          return null;
        } finally {
          setBusy(null);
        }
      }

      setSync({ kind: "pending", message: "Uploading evidence…" });
      const formData = new FormData();
      formData.set("file", file);
      formData.set("jobId", "JOB-2048");
      formData.set("propertyId", "PROP-118");
      formData.set("zoneId", "ZONE-BASEMENT");
      formData.set("phase", semantics.phase);
      formData.set("subject", semantics.subject);
      formData.set("caption", semantics.caption);
      formData.set("capturedAt", String(semantics.capturedAt));
      try {
        const response = await fetch("/api/v1/evidence", {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: formData,
        });
        const body = (await response.json().catch(() => null)) as
          | {
              data?: { record: EvidenceRecord; snapshot: WorkflowSnapshot };
              error?: { message?: string };
            }
          | null;
        if (!response.ok || !body?.data?.snapshot) {
          throw new ResponseError(
            response.status,
            body?.error?.message ?? "Evidence was rejected.",
          );
        }
        setSnapshot(body.data.snapshot);
        snapshotRef.current = body.data.snapshot;
        confirmedSnapshotRef.current = body.data.snapshot;
        setConfirmedVersion(body.data.snapshot.version);
        if (journalStore && journalScope) {
          reflectJournalOperations(await journalStore.list(journalScope));
        } else {
          reflectJournalOperations([]);
        }
        setSync({
          kind: "synced",
          message: `Evidence confirmed by server · workflow v${body.data.snapshot.version}`,
        });
        void refreshAudit();
        void refreshOperations();
        return body.data.snapshot;
      } catch (error) {
        if (error instanceof ResponseError && error.status < 500) {
          setSync({
            kind: "error",
            message: `${error.message} Evidence was not counted.`,
          });
          return null;
        }
        setSync({
          kind: navigator.onLine ? "error" : "offline",
          message: journalStore
            ? "Evidence remains in the actor-scoped journal until upload succeeds."
            : "Durable evidence storage is unavailable on this device; reconnect and capture again.",
        });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [
      reflectJournalOperations,
      refreshAudit,
      refreshOperations,
      refreshWorkflow,
    ],
  );

  const syncPendingWork = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) {
      return;
    }
    const journalStore = journalStoreRef.current;
    const journalExecutor = journalExecutorRef.current;
    const journalScope = journalScopeRef.current;
    if (!journalStore || !journalExecutor || !journalScope) return;

    syncingRef.current = true;
    try {
      const journalPending = countJournalPending(
        await journalStore.list(journalScope),
      );
      if (journalPending === 0) return;
      setSync({
        kind: "pending",
        message: `Retrying ${journalPending} actor-scoped pending item(s)…`,
      });
      const current = await refreshWorkflow(true);
      if (!current) return;
      const result = await journalExecutor.replay(
        journalScope,
        current.version,
      );
      await refreshWorkflow(true);
      const journalOperations = await journalStore.list(journalScope);
      const remaining = countJournalPending(journalOperations);
      reflectJournalOperations(journalOperations);
      if (remaining > 0) {
        setSync({
          kind: result.stoppedBecause === "DEFERRED" ? "pending" : "error",
          message: journalResultMessage(result.stoppedBecause),
        });
      }
    } finally {
      syncingRef.current = false;
    }
  }, [reflectJournalOperations, refreshWorkflow]);

  const resumeBlockedJournalOperation = useCallback(
    async (operation: JournalOperation) => {
      const scope = journalScopeRef.current;
      const store = journalStoreRef.current;
      if (!scope || !store) return;
      setBusy("RECOVER_LOCAL_WORK");
      setSync({
        kind: "pending",
        message: "Verifying membership before retrying blocked local work…",
      });
      try {
        await requestJournalRuntimeAction("fieldproof:journal-resume", {
          scope,
          operationId: operation.id,
          expectedRevision: operation.revision,
        });
        reflectJournalOperations(await store.list(scope));
        await refreshWorkflow(true);
      } catch (error) {
        reflectJournalOperations(await store.list(scope));
        setSync({ kind: "error", message: errorMessage(error) });
      } finally {
        setBusy(null);
      }
    },
    [reflectJournalOperations, refreshWorkflow],
  );

  const discardBlockedJournalOperation = useCallback(
    async (operation: JournalOperation) => {
      const scope = journalScopeRef.current;
      const store = journalStoreRef.current;
      if (!scope || !store || !canSafelyDiscardJournalOperation(operation)) {
        return;
      }
      if (
        !window.confirm(
          "Discard this unapplied local operation and any unapplied work that depends on it?",
        )
      ) {
        return;
      }
      setBusy("DISCARD_LOCAL_WORK");
      try {
        await requestJournalRuntimeAction("fieldproof:journal-discard", {
          scope,
          operationId: operation.id,
          expectedRevision: operation.revision,
        });
        reflectJournalOperations(await store.list(scope));
        await refreshWorkflow(true);
        setSync({
          kind: "synced",
          message: "Unapplied blocked local work was discarded.",
        });
      } catch (error) {
        reflectJournalOperations(await store.list(scope));
        setSync({ kind: "error", message: errorMessage(error) });
      } finally {
        setBusy(null);
      }
    },
    [reflectJournalOperations, refreshWorkflow],
  );

  useEffect(() => {
    if (onlineTick > 0) void syncPendingWork();
  }, [onlineTick, syncPendingWork]);

  function makeCommand(
    type: WorkflowCommand["type"],
    fields: Record<string, unknown> = {},
  ) {
    const current = snapshotRef.current;
    if (!current) return null;
    return {
      commandId: crypto.randomUUID(),
      expectedVersion: current.version,
      type,
      ...fields,
    } as WorkflowCommand;
  }

  async function runCommand(
    type: WorkflowCommand["type"],
    fields: Record<string, unknown> = {},
  ) {
    const command = makeCommand(type, fields);
    return command ? dispatchCommand(command) : null;
  }

  async function processProofDelivery() {
    const operationId = `delivery-${crypto.randomUUID()}`;
    setBusy("PROCESS_DELIVERY");
    setSync({ kind: "pending", message: "Processing queued proof delivery…" });
    try {
      const response = await fetch("/api/v1/outbox", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "Idempotency-Key": operationId,
        },
        body: JSON.stringify({
          action: "PROCESS_PENDING",
          operationId,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            data?: { status?: string };
            error?: { message?: string };
          }
        | null;
      if (!response.ok) {
        throw new ResponseError(
          response.status,
          body?.error?.message ??
            "The queued delivery could not be processed.",
        );
      }
      await refreshWorkflow(true);
      await refreshOperations();
      await refreshAudit();
      setSync({
        kind: "synced",
        message:
          body?.data?.status === "DELIVERED"
            ? "Mock provider confirmed proof delivery"
            : "No proof delivery was ready",
      });
    } catch (error) {
      setSync({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  function go(next: View) {
    if (next === "proof" && !snapshotRef.current?.proofGenerated) {
      setSync({
        kind: "error",
        message: "Service Proof does not exist until the server completes the job.",
      });
      return;
    }
    setView(next);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const selected = useMemo(
    () =>
      huntleyCandidates.find(
        (item) =>
          item.id ===
          (snapshot?.selectedCandidateId ?? selectedCandidateDraft),
      ) ?? huntleyCandidates[0],
    [selectedCandidateDraft, snapshot?.selectedCandidateId],
  );

  const completionReady = Boolean(
    snapshot &&
      snapshot.checkedIn &&
      snapshot.checklist.every(Boolean) &&
      snapshot.evidenceRequirementsSatisfied &&
      snapshot.observation &&
      snapshot.riskReview !== "NOT_REVIEWED" &&
      !snapshot.completed,
  );
  const hasLocalDraft = Boolean(
    pendingCount > 0 &&
      confirmedVersion !== null &&
      snapshot?.version !== confirmedVersion,
  );
  const blockedJournalOperation = blockedJournalOperations[0] ?? null;

  if (!snapshot) {
    return (
      <div className="loading-screen" role="status">
        <div className="brand-mark" aria-hidden="true">
          F
        </div>
        <h1>FieldProof</h1>
        <p>{sync.message}</p>
        {sync.kind === "error" || sync.kind === "offline" ? (
          <button className="button primary" onClick={() => void refreshWorkflow()}>
            Retry connection
          </button>
        ) : null}
      </div>
    );
  }

  const main = (() => {
    switch (view) {
      case "requests":
        return (
          <ServiceRequestView
            snapshot={snapshot}
            busy={busy ?? (pendingCount > 0 ? "PENDING_SYNC" : null)}
            onPropose={() => void runCommand("RUN_TRIAGE")}
            onApprove={() => void runCommand("APPROVE_TRIAGE")}
            onSchedule={() => go("schedule")}
          />
        );
      case "schedule":
        return (
          <ScheduleView
            snapshot={snapshot}
            busy={busy ?? (pendingCount > 0 ? "PENDING_SYNC" : null)}
            selectedId={snapshot.scheduled ? selected.id : selectedCandidateDraft}
            onSelect={setSelectedCandidateDraft}
            onApprove={async () => {
              const result = await runCommand("APPROVE_SCHEDULE", {
                candidateId: selectedCandidateDraft,
              });
              if (result?.scheduled) go("technician");
            }}
            onOpenRequest={() => go("requests")}
          />
        );
      case "technician":
      case "jobs":
        return (
          <TechnicianView
            snapshot={snapshot}
            candidate={selected}
            offlineReady={offlineReady}
            pendingCount={pendingCount}
            busy={busy}
            completionReady={completionReady}
            fileInputRef={fileInputRef}
            onCheckIn={() => void runCommand("CHECK_IN")}
            onToggleChecklist={(index, complete) =>
              void runCommand("SET_CHECKLIST_STEP", { index, complete })
            }
            onAddObservation={(note, category) =>
              void runCommand("ADD_OBSERVATION", {
                note,
                category,
              })
            }
            onReviewRisk={(unresolved) =>
              void runCommand("REVIEW_RISK", { unresolved })
            }
            onComplete={async (actuals) => {
              const result = await runCommand("COMPLETE_JOB", actuals);
              if (result?.proofGenerated) go("proof");
            }}
            onEvidenceFile={(file, semantics) =>
              uploadEvidence(file, semantics)
            }
          />
        );
      case "properties":
        return <PropertyView snapshot={snapshot} />;
      case "exceptions":
        return (
          <ExceptionsView
            snapshot={snapshot}
            busy={busy ?? (pendingCount > 0 ? "PENDING_SYNC" : null)}
            ownerUserId={operations?.identity?.userId ?? ""}
            onResolve={(ownerUserId, resolutionNote) =>
              void runCommand("RESOLVE_EXCEPTION", {
                ownerUserId,
                resolutionNote,
              })
            }
          />
        );
      case "audit":
        return <AuditView items={audit} />;
      case "proof":
        return (
          <ProofView
            snapshot={snapshot}
            candidate={selected}
            operations={operations}
            busy={busy ?? (pendingCount > 0 ? "PENDING_SYNC" : null)}
            onSend={() => void runCommand("SEND_PROOF")}
            onProcessDelivery={() => void processProofDelivery()}
            onVerify={(result, note) =>
              void runCommand("VERIFY_OUTCOME", {
                result,
                source: "STAFF_RECORDED_CUSTOMER_CONFIRMATION",
                note,
              })
            }
            onReservice={(reason, directCostCents) =>
              void runCommand("RECORD_RESERVICE", {
                reserviceJobId: `RESERVICE-${crypto.randomUUID()}`,
                reason,
                directCostCents,
              })
            }
          />
        );
      case "playbooks":
        return <PlaybookView operations={operations} snapshot={snapshot} />;
      case "analytics":
        return <OutcomesView operations={operations} snapshot={snapshot} />;
      case "settings":
        return (
          <IntegrationsView
            operations={operations}
            onRefresh={() => void refreshOperations()}
          />
        );
      default:
        return (
          <ControlTower
            snapshot={snapshot}
            candidate={selected}
            auditCount={audit.length}
            hasLocalDraft={hasLocalDraft}
            onOpenRequest={() => go("requests")}
            onOpenJob={() =>
              go(snapshot.proofGenerated ? "proof" : "technician")
            }
            onOpenExceptions={() => go("exceptions")}
            onOpenAudit={() => go("audit")}
          />
        );
    }
  })();

  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}
        aria-label="Primary navigation"
      >
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <span>F</span>
          </div>
          <div>
            <strong>FieldProof</strong>
            <small>Outcome operations</small>
          </div>
          <button
            className="sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            ×
          </button>
        </div>
        <div className="org-chip">
          <div className="org-avatar">NP</div>
          <div>
            <strong>{operations?.organization?.name ?? "Northstar Pest"}</strong>
            <span>
              {operations?.identity?.role
                ? `${humanize(operations.identity.role)} membership`
                : "Authenticated pilot tenant"}
            </span>
          </div>
        </div>
        <nav className="nav-list">
          {navigation.map((item) => (
            <button
              key={item.id}
              disabled={!item.enabled}
              title={item.enabled ? item.label : "Coming after the pilot"}
              className={
                view === item.id ||
                (item.id === "jobs" && view === "technician")
                  ? "nav-active"
                  : ""
              }
              onClick={() => go(item.id)}
            >
              <span className="nav-mark">{item.mark}</span>
              <span>{item.label}</span>
              {!item.enabled ? <small className="nav-soon">Soon</small> : null}
              {item.id === "exceptions" &&
              snapshot.followUpCreated &&
              !snapshot.exceptionResolved ? (
                <em>1</em>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="autonomy-status">
            <span className="status-dot" />
            <div>
              <strong>Suggest only</strong>
              <span>Human approval is required</span>
            </div>
          </div>
          <button
            className="reset-button"
            disabled={Boolean(busy) || pendingCount > 0}
            title={
              pendingCount > 0
                ? "Resolve pending work before resetting"
                : "Restart the workflow; retained evidence and audit history are not deleted"
            }
            onClick={() => {
              void (async () => {
                const result = await runCommand("RESET_DEMO");
                if (!result) return;
                setSelectedCandidateDraft(huntleyCandidates[0].id);
                go("control");
              })();
            }}
          >
            Restart demo workflow
          </button>
        </div>
      </aside>
      {sidebarOpen ? (
        <button
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation"
        />
      ) : null}
      <div className="main-column">
        <header className="topbar">
          <button
            className="menu-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            ☰
          </button>
          <div className="top-context">
            <span className="eyebrow">Pilot workflow</span>
            <strong>{titleForView(view)}</strong>
          </div>
          <div className="top-actions">
            <div
              className={`sync-state sync-${sync.kind}`}
              title={sync.message}
              role="status"
              aria-live="polite"
            >
              <span className="status-dot" />
              <span>{sync.message}</span>
            </div>
            <div className="pilot-identity">
              <span>Signed in</span>
              <strong>
                {operations?.identity?.displayName ?? "Pilot operator"}
              </strong>
            </div>
            <div className="user-avatar" aria-label="Authenticated user">
              {initials(operations?.identity?.displayName ?? "Pilot operator")}
            </div>
          </div>
        </header>
        {pendingCount > 0 ? (
          <div className="pending-banner" role="status">
            <strong>{pendingCount} item(s) waiting for server confirmation.</strong>
            <span>
              {blockedJournalOperation
                ? blockedJournalOperation.lastError?.message ??
                  "One local operation needs an explicit recovery decision."
                : hasLocalDraft
                  ? "Field edits are local draft state; evidence counts, completion, and proof remain server-only."
                  : "Queued work is not reflected in the authoritative state until a retry succeeds."}
            </span>
            <div className="pending-actions">
              {blockedJournalOperation &&
              (blockedJournalOperation.status === "AUTH_BLOCKED" ||
                blockedJournalOperation.status === "RETRY_PAUSED") ? (
                <button
                  className="text-button"
                  disabled={!navigator.onLine || Boolean(busy)}
                  onClick={() =>
                    void resumeBlockedJournalOperation(
                      blockedJournalOperation,
                    )
                  }
                >
                  Verify sign-in & retry
                </button>
              ) : !blockedJournalOperation ? (
                <button
                  className="text-button"
                  disabled={!navigator.onLine || Boolean(busy)}
                  onClick={() => void syncPendingWork()}
                >
                  Retry now
                </button>
              ) : null}
              {blockedJournalOperation &&
              canSafelyDiscardJournalOperation(blockedJournalOperation) ? (
                <button
                  className="text-button danger"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void discardBlockedJournalOperation(
                      blockedJournalOperation,
                    )
                  }
                >
                  Discard unapplied work
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <main className="workspace">{main}</main>
      </div>
    </div>
  );
}

function ControlTower({
  snapshot,
  candidate,
  auditCount,
  hasLocalDraft,
  onOpenRequest,
  onOpenJob,
  onOpenExceptions,
  onOpenAudit,
}: {
  snapshot: WorkflowSnapshot;
  candidate: (typeof huntleyCandidates)[number];
  auditCount: number;
  hasLocalDraft: boolean;
  onOpenRequest: () => void;
  onOpenJob: () => void;
  onOpenExceptions: () => void;
  onOpenAudit: () => void;
}) {
  const metrics = [
    {
      label: "Workflow state",
      value: snapshot.completed ? "Completed" : workflowStage(snapshot),
      note: hasLocalDraft
        ? "Local draft · awaiting server"
        : `Server version ${snapshot.version}`,
    },
    {
      label: "Expected contribution",
      value: `$${candidate.economics.expectedContributionMargin.toFixed(2)}`,
      note: snapshot.scheduled ? "Approved appointment" : "Leading eligible slot",
    },
    {
      label: "Evidence",
      value: `${snapshot.evidenceCount}/2`,
      note: "Server-confirmed records",
    },
    {
      label: "Recurrence risk",
      value: `${snapshot.riskScore}/100`,
      note: riskLabel(snapshot.riskScore),
    },
    {
      label: "Risk review",
      value: riskReviewLabel(snapshot.riskReview),
      note: snapshot.followUpCreated
        ? "Follow-up created"
        : "No follow-up created",
    },
    {
      label: "Audit events",
      value: String(auditCount),
      note: "Current authorized trace",
    },
  ];
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <p className="kicker">Server-backed pilot</p>
          <h1>One request. One durable outcome loop.</h1>
          <p>
            {hasLocalDraft
              ? `Field edits shown here are an offline draft over workflow ${snapshot.workflowId}.`
              : `Every status below comes from server workflow ${snapshot.workflowId}.`}
          </p>
        </div>
        <div className="intro-actions">
          <button className="button secondary" onClick={onOpenAudit}>
            View decision trace
          </button>
          <button className="button primary" onClick={onOpenRequest}>
            Open priority request
          </button>
        </div>
      </section>
      <section className="metric-grid" aria-label="Live pilot metrics">
        {metrics.map((metric) => (
          <div className="metric-card metric-static" key={metric.label}>
            <span>{metric.label}</span>
            <div>
              <strong>{metric.value}</strong>
            </div>
            <small>{metric.note}</small>
          </div>
        ))}
      </section>
      <section className="control-grid">
        <div className="panel attention-panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Authoritative work</p>
              <h2>Huntley pilot workflow</h2>
            </div>
            <span className="data-time">
              Updated {formatTime(snapshot.updatedAt)}
            </span>
          </div>
          <div className="attention-list">
            <button className="attention-row priority" onClick={onOpenRequest}>
              <span className="severity-bar" />
              <div className="attention-main">
                <div>
                  <span className="status-pill amber">
                    {triageLabel(snapshot.triageStatus)}
                  </span>
                </div>
                <strong>Morrison residence · basement mouse activity</strong>
                <p>
                  AI proposes structured facts. A human must approve them before
                  scheduling.
                </p>
              </div>
              <div className="impact">
                <span>Request</span>
                <strong>{snapshot.serviceRequestId}</strong>
                <em>Review</em>
              </div>
            </button>
            <button className="attention-row" onClick={onOpenJob}>
              <span className="severity-bar blue" />
              <div className="attention-main">
                <div>
                  <span className="status-pill blue">
                    {snapshot.proofGenerated
                      ? "Proof ready"
                      : snapshot.scheduled
                        ? "Field workflow"
                        : "Not scheduled"}
                  </span>
                </div>
                <strong>Job JOB-2048 · Huntley</strong>
                <p>
                  {snapshot.completed
                    ? `Outcome: ${outcomeLabel(snapshot.outcome)}.`
                    : `${snapshot.evidenceCount} server-confirmed evidence item(s).`}
                </p>
              </div>
              <div className="impact">
                <span>Expected margin</span>
                <strong>
                  ${candidate.economics.expectedContributionMargin.toFixed(2)}
                </strong>
                <em>{snapshot.scheduled ? candidate.technician : "Proposed"}</em>
              </div>
            </button>
            {snapshot.followUpCreated ? (
              <button
                className={`attention-row ${snapshot.exceptionResolved ? "muted-row" : ""}`}
                onClick={onOpenExceptions}
              >
                <span className="severity-bar red" />
                <div className="attention-main">
                  <div>
                    <span
                      className={`status-pill ${snapshot.exceptionResolved ? "green" : "red"}`}
                    >
                      {snapshot.exceptionResolved ? "Resolved" : "Needs owner"}
                    </span>
                  </div>
                  <strong>Follow-up ownership exception</strong>
                  <p>
                    This exception was created from the unresolved-risk
                    completion outcome.
                  </p>
                </div>
                <div className="impact">
                  <span>Status</span>
                  <strong>
                    {snapshot.exceptionResolved ? "Closed" : "Open"}
                  </strong>
                  <em>Review</em>
                </div>
              </button>
            ) : (
              <div className="attention-row muted-row empty-exception-row">
                <span className="severity-bar blue" />
                <div className="attention-main">
                  <div>
                    <span className="status-pill green">None</span>
                  </div>
                  <strong>No workflow exception yet</strong>
                  <p>
                    An ownership exception appears only if completion creates an
                    unresolved-risk follow-up.
                  </p>
                </div>
                <div className="impact">
                  <span>Status</span>
                  <strong>Clear</strong>
                  <em>Server state</em>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="panel route-panel">
          <p className="kicker">Approved appointment</p>
          <h2>{snapshot.scheduled ? candidate.technician : "Not scheduled"}</h2>
          <div className="live-assignment">
            <div>
              <span>Start</span>
              <strong>
                {snapshot.scheduled ? candidate.startsAt : "Awaiting approval"}
              </strong>
            </div>
            <div>
              <span>Technician ID</span>
              <strong>{snapshot.assignedTechnicianId ?? "—"}</strong>
            </div>
            <div>
              <span>Candidate</span>
              <strong>{snapshot.selectedCandidateId ?? "—"}</strong>
            </div>
          </div>
          <div className="route-note">
            <span className="status-dot" />
            <p>
              <strong>One source of scheduling truth</strong>
              <br />
              The technician, start time, economics, field brief, and report all
              follow the server-approved candidate.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function ServiceRequestView({
  snapshot,
  busy,
  onPropose,
  onApprove,
  onSchedule,
}: {
  snapshot: WorkflowSnapshot;
  busy: string | null;
  onPropose: () => void;
  onApprove: () => void;
  onSchedule: () => void;
}) {
  const proposed = snapshot.triageStatus !== "NEW";
  const approved = snapshot.triageStatus === "APPROVED";
  const proposal = snapshot.triageProposal;
  return (
    <div className="page-stack narrow-page">
      <section className="page-intro">
        <div>
          <div className="breadcrumb">
            Service Requests / <strong>{snapshot.serviceRequestId}</strong>
          </div>
          <h1>Basement mouse activity</h1>
          <p>Morrison residence · Huntley, Illinois · Received via SMS</p>
        </div>
        <span
          className={`status-pill ${approved ? "green" : proposed ? "blue" : "amber"}`}
        >
          {triageLabel(snapshot.triageStatus)}
        </span>
      </section>
      <div className="detail-grid">
        <div className="detail-main page-stack">
          <section className="panel transcript-card">
            <div className="panel-heading">
              <div>
                <p className="kicker">Untrusted customer input</p>
                <h2>Original message</h2>
              </div>
              <span className="source-badge">SMS · MSG-8821</span>
            </div>
            <blockquote>
              “Hi, we found what looks like mouse droppings along the basement
              wall this morning. We have a dog and our daughter plays down there.
              Can someone check it soon? We’re usually home after lunch.”
            </blockquote>
            <div className="trust-boundary">
              <span>Shielded</span> Customer text is data, never executable
              instruction.
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="kicker">AI-assisted triage</p>
                <h2>Reviewable proposal</h2>
              </div>
              <span className="model-badge">MockAI · validated schema</span>
            </div>
            {!proposed ? (
              <div className="empty-action">
                <div className="analysis-mark">AI</div>
                <h3>Generate a structured proposal</h3>
                <p>
                  The model may extract facts. It cannot approve serviceability
                  or schedule the work.
                </p>
                <button
                  className="button primary"
                  disabled={Boolean(busy)}
                  onClick={onPropose}
                >
                  Generate AI proposal
                </button>
              </div>
            ) : proposal ? (
              <>
                <div className="triage-grid">
                  <Fact
                    label="Issue category"
                    value={humanize(proposal.issueCategory)}
                    source="Validated AI proposal"
                  />
                  <Fact
                    label="Affected zones"
                    value={proposal.affectedZones.join(", ") || "Not identified"}
                    source="Validated AI proposal"
                  />
                  <Fact
                    label="Urgency"
                    value={humanize(proposal.urgency)}
                    source="Validated AI proposal"
                  />
                  <Fact
                    label="Confidence"
                    value={`${Math.round(proposal.confidence * 100)}%`}
                    source="Validated model output"
                  />
                  <Fact
                    label="Proposed service"
                    value={proposal.serviceType}
                    source="Validated AI proposal"
                  />
                  <Fact
                    label="Serviceability"
                    value={proposal.serviceable ? "Serviceable" : "Not serviceable"}
                    source="Deterministic policy review"
                  />
                </div>
                {proposal.safetyFlags.length || proposal.ambiguity.length ? (
                  <div className="proposal-caveats">
                    <strong>Review flags</strong>
                    <span>
                      {[
                        ...proposal.safetyFlags.map((flag) => `Safety: ${flag}`),
                        ...proposal.ambiguity.map(
                          (item) => `Ambiguity: ${item}`,
                        ),
                      ].join(" · ")}
                    </span>
                  </div>
                ) : null}
                <div
                  className={`human-review ${approved ? "approved" : ""}`}
                  role="status"
                >
                  <div className="policy-icon">{approved ? "✓" : "HU"}</div>
                  <div>
                    <strong>
                      {approved
                        ? "Human approval recorded"
                        : "Human judgment required"}
                    </strong>
                    <p>
                      {approved
                        ? "The structured facts and serviceability decision are approved."
                        : "Review the proposal and explicitly approve it before any scheduling decision."}
                    </p>
                  </div>
                  {!approved ? (
                    <button
                      className="button primary"
                      disabled={Boolean(busy) || !proposal.serviceable}
                      onClick={onApprove}
                    >
                      Approve triage
                    </button>
                  ) : (
                    <span className="status-pill green">Approved</span>
                  )}
                </div>
              </>
            ) : (
              <div className="empty-action">
                <h3>Proposal unavailable</h3>
                <p>
                  The server did not return validated triage facts. Approval is
                  blocked until they are available.
                </p>
              </div>
            )}
          </section>
        </div>
        <aside className="detail-aside">
          <section className="panel summary-panel">
            <p className="kicker">Property intelligence</p>
            <h2>1428 Redtail Lane</h2>
            <p>Huntley, IL · Single-family · Quarterly plan</p>
            <div className="risk-row">
              <div className="risk-ring">
                <strong>{snapshot.riskScore}</strong>
                <span>/100</span>
              </div>
              <div>
                <strong>{riskLabel(snapshot.riskScore)} recurrence risk</strong>
                <span>Server score · current workflow</span>
              </div>
            </div>
          </section>
          <section className="panel next-action">
            <p className="kicker">Next action</p>
            <h3>{approved ? "Compare eligible slots" : "Approve triage first"}</h3>
            <p>
              {approved
                ? "Hard constraints and economics are deterministic and shared with the server."
                : "An AI proposal alone cannot advance this request."}
            </p>
            <button
              className="button primary full"
              disabled={!approved}
              onClick={onSchedule}
            >
              Open ranked slots
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ScheduleView({
  snapshot,
  busy,
  selectedId,
  onSelect,
  onApprove,
  onOpenRequest,
}: {
  snapshot: WorkflowSnapshot;
  busy: string | null;
  selectedId: string;
  onSelect: (id: string) => void;
  onApprove: () => void;
  onOpenRequest: () => void;
}) {
  if (snapshot.triageStatus !== "APPROVED") {
    return (
      <div className="page-stack narrow-page">
        <section className="page-intro">
          <div>
            <p className="kicker">Margin-aware scheduling</p>
            <h1>No human-approved request yet</h1>
            <p>Review and approve triage before selecting an appointment.</p>
          </div>
          <button className="button primary" onClick={onOpenRequest}>
            Open service request
          </button>
        </section>
      </div>
    );
  }
  const selected =
    huntleyCandidates.find((item) => item.id === selectedId) ??
    huntleyCandidates[0];
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <div className="breadcrumb">
            Service Requests / SR-1048 / <strong>Schedule</strong>
          </div>
          <h1>
            {snapshot.scheduled
              ? "Approved appointment"
              : "Choose the strongest route fit"}
          </h1>
          <p>
            Eligibility, ranking, and economics come from the shared domain
            model.
          </p>
        </div>
        <span className="status-pill green">3 eligible · 2 excluded</span>
      </section>
      <div className="schedule-layout">
        <section className="candidate-list">
          {huntleyCandidates.map((candidate) => (
            <button
              className={`candidate-card ${selectedId === candidate.id ? "candidate-selected" : ""}`}
              key={candidate.id}
              disabled={snapshot.scheduled || Boolean(busy)}
              onClick={() => onSelect(candidate.id)}
            >
              <div className="rank">#{candidate.rank}</div>
              <div className="candidate-main">
                <div className="candidate-title">
                  <div>
                    <strong>{candidate.startsAt}</strong>
                    <span>
                      {candidate.technician} · {candidate.driveMinutes} min drive
                    </span>
                  </div>
                  <div className="score">
                    <span>Decision score</span>
                    <strong>{candidate.score.toFixed(1)}</strong>
                  </div>
                </div>
                <div className="eligibility-tags">
                  {candidate.eligibilityReasons.map((reason) => (
                    <span key={reason}>✓ {reason}</span>
                  ))}
                </div>
                <div className="candidate-economics">
                  <Economics label="Price" value={candidate.economics.price} />
                  <Economics
                    label="Labor"
                    value={-candidate.economics.laborCost}
                  />
                  <Economics
                    label="Drive"
                    value={-candidate.economics.driveCost}
                  />
                  <Economics
                    label="Materials"
                    value={-candidate.economics.materialEstimate}
                  />
                  <Economics
                    label="Reservice risk"
                    value={-candidate.economics.expectedReserviceCost}
                  />
                  <Economics
                    label="Expected contribution"
                    value={candidate.economics.expectedContributionMargin}
                    contribution
                  />
                </div>
              </div>
            </button>
          ))}
        </section>
        <aside className="panel score-explanation">
          <p className="kicker">Transparent ranking</p>
          <h2>Why #{selected.rank} ranks here</h2>
          <p>
            {selected.technician} is eligible and this route fit protects
            contribution without overtime.
          </p>
          <div className="score-total">
            <span>Decision score</span>
            <strong>{selected.score.toFixed(1)}</strong>
          </div>
          <div className="score-parts">
            {selected.explanation.map((part) => (
              <div key={part.label}>
                <span>{part.label}</span>
                <strong className={part.kind}>
                  {part.value >= 0 ? "+" : ""}
                  {part.value.toFixed(2)}
                </strong>
              </div>
            ))}
          </div>
          <div className="formula-note">
            <strong>Expected contribution formula</strong>
            <code>
              price − labor − drive − material − expected reservice
            </code>
          </div>
          <button
            className="button primary full"
            disabled={snapshot.scheduled || Boolean(busy)}
            onClick={onApprove}
          >
            {snapshot.scheduled
              ? `${selected.technician} approved`
              : `Approve ${selected.startsAt}`}
          </button>
          <p className="approval-note">
            The server records the approved candidate and technician; the shared
            deterministic model supplies its start time and economics.
          </p>
        </aside>
      </div>
    </div>
  );
}

function TechnicianView({
  snapshot,
  candidate,
  offlineReady,
  pendingCount,
  busy,
  completionReady,
  fileInputRef,
  onCheckIn,
  onToggleChecklist,
  onAddObservation,
  onReviewRisk,
  onComplete,
  onEvidenceFile,
}: {
  snapshot: WorkflowSnapshot;
  candidate: (typeof huntleyCandidates)[number];
  offlineReady: boolean;
  pendingCount: number;
  busy: string | null;
  completionReady: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onCheckIn: () => void;
  onToggleChecklist: (index: number, complete: boolean) => void;
  onAddObservation: (
    note: string,
    category: "PEST_EVIDENCE" | "ENTRY_POINT" | "CONDITION" | "OTHER",
  ) => void;
  onReviewRisk: (unresolved: boolean) => void;
  onComplete: (actuals: {
    actualDriveMinutes: number;
    actualMaterialCostCents: number;
    technicianNote: string;
  }) => void;
  onEvidenceFile: (
    file: File,
    semantics: {
      phase: EvidenceRecord["phase"];
      subject: EvidenceRecord["subject"];
      caption: string;
      capturedAt: number;
    },
  ) => Promise<WorkflowSnapshot | null>;
}) {
  const [evidencePhase, setEvidencePhase] =
    useState<EvidenceRecord["phase"]>("BEFORE");
  const [evidenceSubject, setEvidenceSubject] =
    useState<EvidenceRecord["subject"]>("AREA_OVERVIEW");
  const [evidenceCaption, setEvidenceCaption] = useState(
    "Basement work-area overview before inspection.",
  );
  const [observationNote, setObservationNote] = useState(
    "Small dark droppings observed along the north basement sill plate.",
  );
  const [observationCategory, setObservationCategory] = useState<
    "PEST_EVIDENCE" | "ENTRY_POINT" | "CONDITION" | "OTHER"
  >("PEST_EVIDENCE");
  const [actualDriveMinutes, setActualDriveMinutes] = useState(11);
  const [actualMaterialDollars, setActualMaterialDollars] = useState(8);
  const [technicianNote, setTechnicianNote] = useState(
    "Inspection documentation completed and customer aftercare reviewed.",
  );

  if (!snapshot.scheduled) {
    return (
      <div className="page-stack narrow-page">
        <section className="page-intro">
          <div>
            <p className="kicker">Technician workspace</p>
            <h1>No server-confirmed assignment</h1>
            <p>Approve a schedule candidate before field work can begin.</p>
          </div>
        </section>
      </div>
    );
  }
  return (
    <div className="tech-page">
      <header className="tech-job-header">
        <div>
          <span className="status-pill blue">
            {candidate.startsAt} · {candidate.technician}
          </span>
          <h1>Rodent entry-point inspection</h1>
          <p>
            1428 Redtail Lane · Assignment {snapshot.selectedCandidateId} ·{" "}
            {snapshot.assignedTechnicianId}
          </p>
        </div>
        <div className="tech-header-actions">
          <span
            className={`offline-pill ${offlineReady ? "ready" : ""} ${pendingCount ? "pending" : ""}`}
          >
            {pendingCount
              ? `${pendingCount} not yet synced`
              : offlineReady
                ? "✓ Offline queue ready"
                : "Preparing offline storage…"}
          </span>
          {!snapshot.checkedIn ? (
            <button
              className="button primary"
              disabled={Boolean(busy)}
              onClick={onCheckIn}
            >
              Check in
            </button>
          ) : (
            <span className="status-pill green">Checked in</span>
          )}
        </div>
      </header>
      <div className="tech-layout">
        <div className="tech-main page-stack">
          <section className="panel brief-card">
            <div className="panel-heading">
              <div>
                <p className="kicker">Server-approved pre-job brief</p>
                <h2>Inspect first. Document what you can prove.</h2>
              </div>
              <span className="source-badge">{candidate.technician}</span>
            </div>
            <p className="brief-lead">
              Customer reported possible mouse droppings along the basement wall.
              Inspect the perimeter, sill plates, and utility penetrations under
              Rodent Inspection v3.2.
            </p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="kicker">Approved playbook · v3.2</p>
                <h2>Inspection checklist</h2>
              </div>
              <span className="progress-count">
                {snapshot.checklist.filter(Boolean).length} / 4
              </span>
            </div>
            <div className="checklist">
              {checklistLabels.map((label, index) => (
                <label
                  className={snapshot.checklist[index] ? "checked" : ""}
                  key={label}
                >
                  <input
                    type="checkbox"
                    checked={snapshot.checklist[index]}
                    onChange={() =>
                      onToggleChecklist(index, !snapshot.checklist[index])
                    }
                    disabled={
                      !snapshot.checkedIn ||
                      snapshot.completed
                    }
                  />
                  <span className="custom-check">
                    {snapshot.checklist[index] ? "✓" : index + 1}
                  </span>
                  <span>
                    <strong>{label}</strong>
                    <small>Required server-confirmed inspection step</small>
                  </span>
                  <em>Required</em>
                </label>
              ))}
            </div>
          </section>
          <section className="capture-grid">
            <div className="panel capture-panel">
              <div className="panel-heading">
                <div>
                  <p className="kicker">Evidence ledger</p>
                  <h2>Capture proof</h2>
                </div>
                <span className="progress-count">
                  {snapshot.evidenceCount} / 2 min.
                </span>
              </div>
              <div className="evidence-list">
                {snapshot.evidence.map((record) => (
                  <EvidenceItem
                    key={record.id}
                    id={record.id}
                    kind={humanize(record.phase)}
                    label={record.caption ?? humanize(record.subject)}
                  />
                ))}
              </div>
              {!snapshot.completed ? (
                <div className="field-form">
                  <label>
                    Capture phase
                    <select
                      value={evidencePhase}
                      onChange={(event) =>
                        setEvidencePhase(
                          event.target.value as EvidenceRecord["phase"],
                        )
                      }
                    >
                      <option value="BEFORE">Before</option>
                      <option value="DURING">During</option>
                      <option value="AFTER">After</option>
                    </select>
                  </label>
                  <label>
                    Evidence subject
                    <select
                      value={evidenceSubject}
                      onChange={(event) =>
                        setEvidenceSubject(
                          event.target.value as EvidenceRecord["subject"],
                        )
                      }
                    >
                      <option value="AREA_OVERVIEW">Area overview</option>
                      <option value="PEST_EVIDENCE">Pest evidence</option>
                      <option value="ENTRY_POINT">Entry point</option>
                      <option value="WORK_PERFORMED">Work performed</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </label>
                  <label className="field-span">
                    Caption
                  <input
                      value={evidenceCaption}
                      maxLength={240}
                      onChange={(event) =>
                        setEvidenceCaption(event.target.value)
                      }
                    />
                  </label>
                </div>
              ) : null}
              {!snapshot.evidenceRequirementsSatisfied ? (
                <div className="trust-boundary">
                  <span>Missing</span>{" "}
                  {snapshot.missingEvidenceRequirementIds
                    .map((item) => item.replace("REQ-", "").replaceAll("-", " "))
                    .join(" · ")}
                </div>
              ) : (
                <div className="trust-boundary">
                  <span>Passed</span> Typed evidence policy{" "}
                  {snapshot.evidencePolicyVersion}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void onEvidenceFile(file, {
                      phase: evidencePhase,
                      subject: evidenceSubject,
                      caption: evidenceCaption,
                      capturedAt: Date.now(),
                    });
                  }
                  event.target.value = "";
                }}
              />
              <button
                className="button secondary full"
                disabled={
                  !snapshot.checkedIn ||
                  snapshot.completed ||
                  Boolean(busy)
                }
                onClick={() => fileInputRef.current?.click()}
              >
                Capture or choose photo
              </button>
            </div>
            <div className="panel observation-panel">
              <div className="panel-heading">
                <div>
                  <p className="kicker">Structured field facts</p>
                  <h2>Observation</h2>
                </div>
              </div>
              {!snapshot.observation ? (
                <div className="field-form observation-form">
                  <label>
                    Category
                    <select
                      value={observationCategory}
                      onChange={(event) =>
                        setObservationCategory(
                          event.target.value as typeof observationCategory,
                        )
                      }
                    >
                      <option value="PEST_EVIDENCE">Pest evidence</option>
                      <option value="ENTRY_POINT">Entry point</option>
                      <option value="CONDITION">Condition</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </label>
                  <label className="field-span">
                    Field observation
                    <textarea
                      rows={4}
                      minLength={3}
                      maxLength={1000}
                      value={observationNote}
                      onChange={(event) =>
                        setObservationNote(event.target.value)
                      }
                    />
                  </label>
                  <button
                    className="button secondary field-span"
                    disabled={
                      !snapshot.checkedIn ||
                      snapshot.completed ||
                      Boolean(busy) ||
                      observationNote.trim().length < 3
                    }
                    onClick={() =>
                      onAddObservation(
                        observationNote.trim(),
                        observationCategory,
                      )
                    }
                  >
                    Save field observation
                  </button>
                </div>
              ) : (
                <div className="observation-record">
                  <div>
                    <span className="status-pill blue">
                      {humanize(snapshot.observationCategory ?? "OTHER")}
                    </span>
                    <em>Basement</em>
                  </div>
                  <strong>{snapshot.observation}</strong>
                  <p>Structured observation confirmed by the server.</p>
                </div>
              )}
              <div className="risk-review">
                <div>
                  <strong>Required risk review</strong>
                  <p>
                    A clean visit may be marked clear. An unresolved condition
                    creates follow-up work.
                  </p>
                </div>
                <div className="risk-choice" role="group" aria-label="Risk review">
                  <button
                    className={
                      snapshot.riskReview === "CLEAR" ? "selected clear" : ""
                    }
                    disabled={
                      !snapshot.observation ||
                      snapshot.completed ||
                      Boolean(busy)
                    }
                    onClick={() => onReviewRisk(false)}
                  >
                    {snapshot.riskReview === "CLEAR" ? "✓ " : ""}No unresolved
                    risk
                  </button>
                  <button
                    className={
                      snapshot.riskReview === "UNRESOLVED"
                        ? "selected unresolved"
                        : ""
                    }
                    disabled={
                      !snapshot.observation ||
                      snapshot.completed ||
                      Boolean(busy)
                    }
                    onClick={() => onReviewRisk(true)}
                  >
                    {snapshot.riskReview === "UNRESOLVED" ? "✓ " : ""}Unresolved
                    risk
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
        <aside className="tech-aside">
          <section className="panel completion-card">
            <p className="kicker">Server completion gate</p>
            <h2>
              {snapshot.completed
                ? "Server confirmed completion"
                : completionReady
                  ? "Ready to complete"
                  : "Finish required proof"}
            </h2>
            <div className="gate-list">
              <Gate label="Checked in" passed={snapshot.checkedIn} />
              <Gate
                label="4 required steps"
                passed={snapshot.checklist.every(Boolean)}
              />
              <Gate
                label="Typed evidence policy"
                passed={snapshot.evidenceRequirementsSatisfied}
              />
              <Gate
                label="Structured observation"
                passed={Boolean(snapshot.observation)}
              />
              <Gate
                label="Risk reviewed: clear or unresolved"
                passed={snapshot.riskReview !== "NOT_REVIEWED"}
              />
            </div>
            {!snapshot.completed ? (
              <div className="field-form completion-inputs">
                <label>
                  Actual drive minutes
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={actualDriveMinutes}
                    onChange={(event) =>
                      setActualDriveMinutes(Number(event.target.value))
                    }
                  />
                </label>
                <label>
                  Actual materials ($)
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    step="0.01"
                    value={actualMaterialDollars}
                    onChange={(event) =>
                      setActualMaterialDollars(Number(event.target.value))
                    }
                  />
                </label>
                <label className="field-span">
                  Completion note
                  <textarea
                    rows={3}
                    minLength={3}
                    maxLength={2000}
                    value={technicianNote}
                    onChange={(event) => setTechnicianNote(event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            <button
              className="button primary full"
              disabled={!completionReady || Boolean(busy)}
              onClick={() =>
                onComplete({
                  actualDriveMinutes,
                  actualMaterialCostCents: Math.round(
                    actualMaterialDollars * 100,
                  ),
                  technicianNote: technicianNote.trim(),
                })
              }
            >
              Mark field work complete & generate proof
            </button>
            <p className="approval-note">
              This records field completion and starts verification. It does not
              claim the issue is resolved.
            </p>
          </section>
          <section className="panel property-mini">
            <p className="kicker">Live workflow state</p>
            <h3>Version {snapshot.version}</h3>
            <ul>
              <li>Evidence: {snapshot.evidenceCount}</li>
              <li>Risk: {riskReviewLabel(snapshot.riskReview)}</li>
              <li>Outcome: {outcomeLabel(snapshot.outcome)}</li>
              <li>Proof: {snapshot.proofGenerated ? "Generated" : "Not generated"}</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ProofView({
  snapshot,
  candidate,
  operations,
  busy,
  onSend,
  onProcessDelivery,
  onVerify,
  onReservice,
}: {
  snapshot: WorkflowSnapshot;
  candidate: (typeof huntleyCandidates)[number];
  operations: OperationsData | null;
  busy: string | null;
  onSend: () => void;
  onProcessDelivery: () => void;
  onVerify: (
    result:
      | "RESOLVED"
      | "PARTIALLY_RESOLVED"
      | "UNRESOLVED"
      | "CUSTOMER_UNREACHABLE",
    note: string,
  ) => void;
  onReservice: (reason: string, directCostCents: number) => void;
}) {
  const [verificationResult, setVerificationResult] = useState<
    "RESOLVED" | "PARTIALLY_RESOLVED" | "UNRESOLVED" | "CUSTOMER_UNREACHABLE"
  >("RESOLVED");
  const [verificationNote, setVerificationNote] = useState(
    "Customer confirmed that no new activity has been observed since service.",
  );
  const [reserviceReason, setReserviceReason] = useState(
    "Customer reported renewed activity during the verification window.",
  );
  const [reserviceCostDollars, setReserviceCostDollars] = useState(45);
  if (!snapshot.proofGenerated) {
    return <ComingSoonView area="Service Proof awaiting server completion" />;
  }
  const unresolved = snapshot.riskReview === "UNRESOLVED";
  const deliveryQueued = [
    "QUEUED",
    "SENDING",
    "FAILED_RETRYABLE",
  ].includes(snapshot.proofDeliveryStatus);
  const verified = snapshot.outcome !== "PENDING_VERIFICATION";
  const canonicalAppointment =
    operations?.appointment?.starts_at === undefined
      ? "Unavailable"
      : `${formatTime(operations.appointment.starts_at)} · ${
          operations.appointment.duration_minutes ?? 0
        } min`;
  return (
    <div className="proof-page page-stack">
      <section className="page-intro no-print">
        <div>
          <div className="breadcrumb">
            Jobs / {snapshot.jobId} / <strong>Service Proof</strong>
          </div>
          <h1>Immutable field record</h1>
          <p>
            Field work is complete. Resolution remains pending until an
            independent checkpoint confirms the outcome.
          </p>
        </div>
        <div className="intro-actions">
          <button className="button secondary" onClick={() => window.print()}>
            Print / Save PDF
          </button>
          <button
            className="button primary"
            onClick={deliveryQueued ? onProcessDelivery : onSend}
            disabled={snapshot.proofSent || Boolean(busy)}
          >
            {snapshot.proofSent
              ? "Delivered"
              : deliveryQueued
                ? "Process mock delivery"
                : "Queue Service Proof delivery"}
          </button>
        </div>
      </section>
      <article className="service-proof">
        <header className="proof-header">
          <div>
            <span className="proof-logo">F</span>
            <div>
              <strong>FieldProof</strong>
              <small>Service proof by Northstar Pest</small>
            </div>
          </div>
          <div>
            <span>Workflow</span>
            <strong>{snapshot.workflowId}</strong>
            <small>Version {snapshot.version}</small>
          </div>
        </header>
        <section className="proof-hero">
          <div>
            <p className="kicker">Field work complete</p>
            <h1>Rodent entry-point inspection</h1>
            <p>1428 Redtail Lane · Huntley, Illinois</p>
          </div>
          <span className="proof-check">✓</span>
        </section>
        <section className="proof-summary">
          <div>
            <span>Technician</span>
            <strong>{candidate.technician}</strong>
          </div>
          <div>
            <span>Appointment</span>
            <strong>{canonicalAppointment}</strong>
          </div>
          <div>
            <span>Outcome status</span>
            <strong>{outcomeLabel(snapshot.outcome)}</strong>
          </div>
          <div>
            <span>Proof delivery</span>
            <strong>{humanize(snapshot.proofDeliveryStatus)}</strong>
          </div>
        </section>
        <section className="proof-two-col">
          <div className="proof-section">
            <p className="kicker">Observation</p>
            <h2>Field finding</h2>
            <p>{snapshot.observation}</p>
            <span className="fact-source">Source · server workflow</span>
          </div>
          <div className={`proof-section ${unresolved ? "risk-proof" : ""}`}>
            <p className="kicker">
              {unresolved ? "Follow-up required" : "Risk review"}
            </p>
            <h2>
              {unresolved
                ? "Potential entry point remains unresolved"
                : "No unresolved condition documented"}
            </h2>
            <p>
              {unresolved
                ? "A follow-up record was created as part of completion."
                : "The technician explicitly reviewed and cleared unresolved risk."}
            </p>
            <span
              className={`status-pill ${unresolved ? "amber" : "green"}`}
            >
              {unresolved ? "Follow-up created" : "Reviewed clear"}
            </span>
          </div>
        </section>
        <section className="proof-section">
          <div className="panel-heading">
            <div>
              <p className="kicker">Evidence</p>
              <h2>Server-confirmed visit records</h2>
            </div>
            <span>{snapshot.evidenceCount} attributed records</span>
          </div>
          <div className="proof-evidence">
            {snapshot.evidence.map((record) => (
              <EvidenceItem
                key={record.id}
                id={record.id}
                kind={humanize(record.phase)}
                label={record.caption ?? humanize(record.subject)}
              />
            ))}
          </div>
        </section>
        <section className="proof-footer-grid">
          <div>
            <p className="kicker">Current recurrence risk</p>
            <strong>
              {snapshot.riskScore}/100 · {riskLabel(snapshot.riskScore)}
            </strong>
            <span>Server-calculated score</span>
          </div>
          <div>
            <p className="kicker">Verification checkpoint</p>
            <strong>
              {verified
                ? outcomeLabel(snapshot.outcome)
                : `Due ${formatDate(snapshot.verificationWindowEndsAt)}`}
            </strong>
            <span>
              {snapshot.verification
                ? `${humanize(snapshot.verification.source)} · recorded by ${snapshot.verification.verifiedById}`
                : "No resolution claim yet"}
            </span>
          </div>
        </section>
        <section className="proof-section proof-integrity">
          <p className="kicker">Integrity</p>
          <h2>Immutable proof fingerprint</h2>
          <code>{snapshot.proofSha256 ?? "Hash unavailable"}</code>
          <span>
            Report {snapshot.proofId} · revision {snapshot.proofRevision}
          </span>
        </section>
      </article>
      <section className="outcome-action-grid no-print">
        <div className="panel">
          <p className="kicker">Independent staff outcome check</p>
          <h2>
            {verified
              ? `Verified: ${outcomeLabel(snapshot.outcome)}`
              : "Confirm what happened after the visit"}
          </h2>
          {verified ? (
            <div className="trust-boundary">
              <span>Recorded</span>{" "}
              {snapshot.verification?.note ?? "Outcome checkpoint completed."}
            </div>
          ) : (
            <div className="field-form">
              <label>
                Result
                <select
                  value={verificationResult}
                  onChange={(event) =>
                    setVerificationResult(
                      event.target.value as typeof verificationResult,
                    )
                  }
                >
                  <option value="RESOLVED">Resolved</option>
                  <option value="PARTIALLY_RESOLVED">Partially resolved</option>
                  <option value="UNRESOLVED">Unresolved</option>
                  <option value="CUSTOMER_UNREACHABLE">
                    Customer unreachable
                  </option>
                </select>
              </label>
              <label className="field-span">
                Verification note
                <textarea
                  rows={3}
                  value={verificationNote}
                  onChange={(event) => setVerificationNote(event.target.value)}
                />
              </label>
              <button
                className="button primary field-span"
                disabled={Boolean(busy) || verificationNote.trim().length < 3}
                onClick={() =>
                  onVerify(verificationResult, verificationNote.trim())
                }
              >
                Attest to customer-confirmed outcome
              </button>
            </div>
          )}
        </div>
        <div className="panel">
          <p className="kicker">Reservice economics</p>
          <h2>Link downstream cost to this job</h2>
          <div className="field-form">
            <label className="field-span">
              Reason
              <textarea
                rows={3}
                value={reserviceReason}
                onChange={(event) => setReserviceReason(event.target.value)}
              />
            </label>
            <label>
              Direct cost ($)
              <input
                type="number"
                min={0}
                step="0.01"
                value={reserviceCostDollars}
                onChange={(event) =>
                  setReserviceCostDollars(Number(event.target.value))
                }
              />
            </label>
            <button
              className="button secondary"
              disabled={Boolean(busy) || reserviceReason.trim().length < 3}
              onClick={() =>
                onReservice(
                  reserviceReason.trim(),
                  Math.round(reserviceCostDollars * 100),
                )
              }
            >
              Link reservice
            </button>
          </div>
          <div className="trust-boundary">
            <span>Actual</span>{" "}
            {formatMoney(
              operations?.economics?.find((item) => item.phase === "FINAL")
                ?.actual_reservice_cost_cents ??
                snapshot.actualReserviceCostCents,
            )}{" "}
            linked reservice cost
          </div>
        </div>
      </section>
    </div>
  );
}

function PropertyView({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const unresolved = snapshot.riskReview === "UNRESOLVED";
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <div className="breadcrumb">
            Properties / <strong>{snapshot.propertyId}</strong>
          </div>
          <h1>1428 Redtail Lane</h1>
          <p>Morrison residence · Huntley · Quarterly recurring service</p>
        </div>
        <span
          className={`status-pill ${unresolved ? "amber" : snapshot.riskReview === "CLEAR" ? "green" : "blue"}`}
        >
          {riskReviewLabel(snapshot.riskReview)}
        </span>
      </section>
      <section className="property-score-grid">
        <ScoreCard
          label="Recurrence risk"
          value={`${snapshot.riskScore}/100`}
          note="Current server score."
        />
        <ScoreCard
          label="Evidence ledger"
          value={String(snapshot.evidenceCount)}
          note="Authorized records for this job."
        />
        <ScoreCard
          label="Outcome"
          value={outcomeLabel(snapshot.outcome)}
          note="Created at server-confirmed completion."
        />
        <ScoreCard
          label="Follow-up"
          value={snapshot.followUpCreated ? "Created" : "None"}
          note="Derived from the explicit risk review."
        />
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="kicker">Living record</p>
            <h2>Current pilot facts</h2>
          </div>
          <span>Workflow v{snapshot.version}</span>
        </div>
        <div className="timeline">
          {snapshot.completed ? (
            <TimelineItem
              date={formatTime(snapshot.updatedAt)}
              title={`Inspection completed · ${outcomeLabel(snapshot.outcome)}`}
              text={
                snapshot.followUpCreated
                  ? "Server created a follow-up from the unresolved risk."
                  : "No unresolved risk remained after explicit review."
              }
              tone={snapshot.followUpCreated ? "amber" : "green"}
            />
          ) : null}
          <TimelineItem
            date="Current request"
            title="Basement rodent concern received"
            text={`Service request ${snapshot.serviceRequestId}.`}
            tone="blue"
          />
        </div>
      </section>
    </div>
  );
}

function ExceptionsView({
  snapshot,
  busy,
  ownerUserId,
  onResolve,
}: {
  snapshot: WorkflowSnapshot;
  busy: string | null;
  ownerUserId: string;
  onResolve: (ownerUserId: string, resolutionNote: string) => void;
}) {
  const [resolutionNote, setResolutionNote] = useState(
    "Pilot owner accepted the follow-up and scheduled customer contact.",
  );
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <p className="kicker">Pilot exception control</p>
          <h1>Work that needs judgment</h1>
          <p>
            Follow-up ownership appears only after an unresolved-risk outcome.
          </p>
        </div>
        <span
          className={`status-pill ${snapshot.followUpCreated && !snapshot.exceptionResolved ? "amber" : "green"}`}
        >
          {snapshot.followUpCreated && !snapshot.exceptionResolved
            ? "1 open"
            : "0 open"}
        </span>
      </section>
      <section className="panel">
        {snapshot.followUpCreated ? (
          <div className="exception-list">
            <div
              className={`exception-item ${snapshot.exceptionResolved ? "resolved" : ""}`}
            >
              <div className="exception-severity high">HIGH</div>
              <div className="exception-copy">
                <div>
                  <span>Follow-up ownership</span>
                  <small>EX-771 · server-backed</small>
                </div>
                <h3>Potential follow-up requires an assigned owner</h3>
                <p>
                  Morrison residence · {snapshot.jobId} · human approval
                  required.
                </p>
              </div>
              <div className="exception-actions">
                {snapshot.exceptionResolved ? (
                  <div>
                    <span className="status-pill green">Resolved</span>
                    <small>
                      {snapshot.exceptionOwnerUserId} ·{" "}
                      {snapshot.exceptionResolutionNote}
                    </small>
                  </div>
                ) : (
                  <div className="field-form">
                    <label>
                      Owner ID
                      <input value={ownerUserId} readOnly />
                    </label>
                    <label className="field-span">
                      Resolution note
                      <textarea
                        rows={3}
                        value={resolutionNote}
                        onChange={(event) =>
                          setResolutionNote(event.target.value)
                        }
                      />
                    </label>
                    <button
                      className="button primary field-span"
                      disabled={
                        Boolean(busy) ||
                        !ownerUserId.trim() ||
                        resolutionNote.trim().length < 3
                      }
                      onClick={() =>
                        onResolve(
                          ownerUserId.trim(),
                          resolutionNote.trim(),
                        )
                      }
                    >
                      Assign owner & resolve
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-action">
            <div className="analysis-mark">✓</div>
            <h3>No workflow exception yet</h3>
            <p>
              Completing a clean job creates no follow-up ownership work. An
              unresolved risk will create the exception transactionally.
            </p>
          </div>
        )}
        <div className="pilot-limit">
          <strong>Additional exception types</strong>
          <span>Coming after this end-to-end pilot is verified.</span>
        </div>
      </section>
    </div>
  );
}

function AuditView({ items }: { items: AuditItem[] }) {
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <p className="kicker">Decision trace</p>
          <h1>Audit and provenance</h1>
          <p>Authorized server events for the pilot tenant.</p>
        </div>
      </section>
      <section className="panel">
        {items.length ? (
          <div className="audit-list">
            {items.map((item) => (
              <article className="audit-item" key={item.id}>
                <div className={`actor-mark ${item.actor_type.toLowerCase()}`}>
                  {item.actor_type === "HUMAN"
                    ? "HU"
                    : item.actor_type === "SYSTEM"
                      ? "SY"
                      : "AI"}
                </div>
                <div className="audit-copy">
                  <div>
                    <strong>{item.action}</strong>
                    <span>{formatTime(item.occurred_at)}</span>
                  </div>
                  <p>{item.reason}</p>
                  <small>
                    {item.id}
                    {item.policy_version ? ` · ${item.policy_version}` : ""}
                  </small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-action">
            <h3>No authorized audit events returned</h3>
            <p>The client does not manufacture fallback events.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function PlaybookView({
  operations,
  snapshot,
}: {
  operations: OperationsData | null;
  snapshot: WorkflowSnapshot;
}) {
  const requirements = safeJsonArray(
    operations?.playbook?.required_evidence_json,
  );
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <p className="kicker">Versioned field standard</p>
          <h1>
            Rodent entry-point inspection ·{" "}
            {operations?.playbook?.version_label ?? "ROD v3.2"}
          </h1>
          <p>
            The job is pinned to {snapshot.playbookVersionId}; its requirements
            do not drift during execution.
          </p>
        </div>
        <span className="status-pill green">Approved</span>
      </section>
      <section className="control-grid">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Required work</p>
              <h2>Inspection sequence</h2>
            </div>
            <span>{checklistLabels.length} gates</span>
          </div>
          <div className="checklist static-checklist">
            {checklistLabels.map((label, index) => (
              <div className={snapshot.checklist[index] ? "checked" : ""} key={label}>
                <span className="custom-check">
                  {snapshot.checklist[index] ? "✓" : index + 1}
                </span>
                <span>
                  <strong>{label}</strong>
                  <small>
                    {snapshot.checklist[index]
                      ? "Confirmed on this job"
                      : "Required before field completion"}
                  </small>
                </span>
              </div>
            ))}
          </div>
        </div>
        <aside className="panel">
          <p className="kicker">Evidence policy</p>
          <h2>{snapshot.evidencePolicyVersion}</h2>
          <div className="source-list">
            {(requirements.length
              ? requirements
              : [
                  { phase: "BEFORE", subject: "AREA_OVERVIEW", minimum: 1 },
                  { phase: "DURING", subject: "ENTRY_POINT", minimum: 1 },
                ]
            ).map((item, index) => (
              <div className="trust-boundary" key={index}>
                <span>{String(item.phase ?? "Required")}</span>{" "}
                {humanize(String(item.subject ?? "evidence"))} · minimum{" "}
                {String(item.minimum ?? 1)}
              </div>
            ))}
          </div>
          <p className="approval-note">
            File count alone cannot satisfy this gate. Phase, subject, capture
            time, job, property, zone, technician, and content hash are
            validated server-side.
          </p>
        </aside>
      </section>
    </div>
  );
}

function OutcomesView({
  operations,
  snapshot,
}: {
  operations: OperationsData | null;
  snapshot: WorkflowSnapshot;
}) {
  const economics = operations?.economics ?? [];
  const expected = economics.find((item) => item.phase === "EXPECTED");
  const actual = economics.find((item) => item.phase === "ACTUAL");
  const final = economics.find((item) => item.phase === "FINAL");
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <p className="kicker">Outcome intelligence</p>
          <h1>From field completion to verified resolution</h1>
          <p>
            Revenue is not the finish line. This view connects evidence,
            delayed outcome, reservice cost, and contribution.
          </p>
        </div>
        <span
          className={`status-pill ${
            snapshot.outcome === "RESOLVED" ? "green" : "amber"
          }`}
        >
          {outcomeLabel(snapshot.outcome)}
        </span>
      </section>
      <section className="metric-grid outcomes-metrics">
        <ScoreCard
          label="Expected contribution"
          value={formatMoney(
            expected?.contribution_margin_cents ??
              snapshot.expectedEconomics?.contributionMarginCents,
          )}
          note="At scheduling approval."
        />
        <ScoreCard
          label="Actual contribution"
          value={formatMoney(
            actual?.contribution_margin_cents ??
              snapshot.actualEconomics?.contributionMarginCents,
          )}
          note="At field completion."
        />
        <ScoreCard
          label="Final contribution"
          value={formatMoney(
            final?.contribution_margin_cents ??
              snapshot.finalEconomics?.contributionMarginCents,
          )}
          note="After verified outcome and linked reservice."
        />
        <ScoreCard
          label="Actual reservice cost"
          value={formatMoney(
            final?.actual_reservice_cost_cents ??
              snapshot.actualReserviceCostCents,
          )}
          note="Attributed to the original job."
        />
      </section>
      <section className="control-grid">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Assurance timeline</p>
              <h2>{snapshot.jobId}</h2>
            </div>
            <span>Outcome v{snapshot.outcomeVersion}</span>
          </div>
          <div className="timeline">
            {snapshot.verification ? (
              <TimelineItem
                date={formatTime(snapshot.verification.verifiedAt)}
                title={`Independently verified · ${outcomeLabel(snapshot.outcome)}`}
                text={`${humanize(snapshot.verification.source)} · ${snapshot.verification.note}`}
                tone="green"
              />
            ) : null}
            {snapshot.completedAt ? (
              <TimelineItem
                date={formatTime(snapshot.completedAt)}
                title="Field work completed"
                text={`Technician assessment: ${humanize(snapshot.technicianAssessment ?? "unknown")}. Verification remained pending.`}
                tone="blue"
              />
            ) : null}
            <TimelineItem
              date="Scheduled"
              title="Expected economics frozen"
              text="The approved route candidate established the pre-job contribution baseline."
              tone="blue"
            />
          </div>
        </div>
        <aside className="panel">
          <p className="kicker">North star</p>
          <h2>Verified-resolved contribution per technician-day</h2>
          <p className="brief-lead">
            This pilot proves the unit loop. A statistically useful cohort
            requires real field volume and delayed observations.
          </p>
          <div className="gate-list">
            <Gate label="Field evidence policy" passed={snapshot.evidenceRequirementsSatisfied} />
            <Gate label="Actual economics" passed={Boolean(snapshot.actualEconomics)} />
            <Gate label="Independent verification" passed={Boolean(snapshot.verification)} />
            <Gate label="Final economics" passed={Boolean(snapshot.finalEconomics)} />
          </div>
        </aside>
      </section>
    </div>
  );
}

function IntegrationsView({
  operations,
  onRefresh,
}: {
  operations: OperationsData | null;
  onRefresh: () => void;
}) {
  const [detail, setDetail] = useState<{
    connections?: Array<Record<string, unknown>>;
    syncs?: Array<Record<string, unknown>>;
    errors?: Array<Record<string, unknown>>;
    productionCredentialGate?: Record<string, string>;
  } | null>(null);
  const [outbox, setOutbox] = useState<{
    counts?: Record<string, number>;
  } | null>(null);
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [integrationMessage, setIntegrationMessage] = useState(
    "Shadow mode is read-only until reconciliation is reviewed.",
  );

  const load = useCallback(async () => {
    const [integrationResponse, outboxResponse] = await Promise.all([
      fetch("/api/v1/integrations", {
        headers: { accept: "application/json" },
        cache: "no-store",
      }),
      fetch("/api/v1/outbox", {
        headers: { accept: "application/json" },
        cache: "no-store",
      }),
    ]);
    if (integrationResponse.ok) {
      const body = (await integrationResponse.json()) as {
        data?: typeof detail;
      };
      if (body.data) setDetail(body.data);
    }
    if (outboxResponse.ok) {
      const body = (await outboxResponse.json()) as {
        data?: typeof outbox;
      };
      if (body.data) setOutbox(body.data);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function runShadowSync() {
    const idempotencyKey = `shadow-${crypto.randomUUID()}`;
    setIntegrationBusy(true);
    setIntegrationMessage("Reconciling mock FSM records…");
    try {
      const response = await fetch("/api/v1/integrations", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          type: "RUN_MOCK_SYNC",
          idempotencyKey,
          simulateFailure: false,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            data?: {
              status?: string;
              totals?: { succeeded?: number; received?: number };
            };
            error?: { message?: string };
          }
        | null;
      if (!response.ok && response.status !== 201) {
        throw new Error(body?.error?.message ?? "Shadow sync failed.");
      }
      setIntegrationMessage(
        `${body?.data?.status ?? "Completed"} · ${
          body?.data?.totals?.succeeded ?? 0
        }/${body?.data?.totals?.received ?? 0} reconciled`,
      );
      await load();
      onRefresh();
    } catch (error) {
      setIntegrationMessage(errorMessage(error));
    } finally {
      setIntegrationBusy(false);
    }
  }

  const connection =
    detail?.connections?.[0] ??
    (operations?.integration?.connection as Record<string, unknown> | null);
  const latest =
    detail?.syncs?.[0] ??
    (operations?.integration?.syncs?.[0] as Record<string, unknown> | undefined);
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <p className="kicker">Vendor-neutral overlay</p>
          <h1>Integration control & reconciliation</h1>
          <p>
            FieldProof can coexist with the system of record. This pilot
            validates contracts in mock shadow mode before vendor writes.
          </p>
        </div>
        <button
          className="button primary"
          disabled={integrationBusy}
          onClick={() => void runShadowSync()}
        >
          Run mock shadow sync
        </button>
      </section>
      <section className="metric-grid outcomes-metrics">
        <ScoreCard
          label="Connection"
          value={String(connection?.provider ?? "MOCK")}
          note={`${String(connection?.mode ?? "SHADOW_READ_ONLY")} · ${String(
            connection?.status ?? "CONNECTED",
          )}`}
        />
        <ScoreCard
          label="Latest sync"
          value={String(latest?.status ?? "Not run")}
          note={integrationMessage}
        />
        <ScoreCard
          label="Pending outbox"
          value={String(outbox?.counts?.pendingOutbox ?? 0)}
          note="Durable operations awaiting processing."
        />
        <ScoreCard
          label="Dead letter"
          value={String(outbox?.counts?.deadLetter ?? 0)}
          note="Terminal failures requiring intervention."
        />
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="kicker">Production connector gates</p>
            <h2>No simulated vendor capability claims</h2>
          </div>
          <span>Credential-bound verification</span>
        </div>
        <div className="integration-gates">
          {Object.entries(
            detail?.productionCredentialGate ?? {
              FIELDROUTES: "REQUIRES_VENDOR_ACCESS",
              PESTPAC: "REQUIRES_VENDOR_ACCESS",
              GORILLADESK: "REQUIRES_VENDOR_ACCESS",
            },
          ).map(([provider, gate]) => (
            <div className="trust-boundary" key={provider}>
              <span>{provider}</span> {humanize(gate)}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ComingSoonView({ area }: { area: string }) {
  return (
    <div className="page-stack narrow-page">
      <section className="panel coming-soon">
        <span className="status-pill blue">After pilot</span>
        <h1>{area}</h1>
        <p>
          This surface is intentionally unavailable until the core
          request-to-proof workflow is durable, authorized, and verified.
        </p>
      </section>
    </div>
  );
}

function Fact({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source: string;
}) {
  return (
    <div className="fact-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>Source · {source}</small>
    </div>
  );
}

function Economics({
  label,
  value,
  contribution = false,
}: {
  label: string;
  value: number;
  contribution?: boolean;
}) {
  return (
    <div className={contribution ? "contribution" : ""}>
      <span>{label}</span>
      <strong>
        {value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}
      </strong>
    </div>
  );
}

function ScoreCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="panel score-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{note}</p>
    </div>
  );
}

function Gate({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className={passed ? "passed" : ""}>
      <span>{passed ? "✓" : "○"}</span>
      <strong>{label}</strong>
      <em>{passed ? "Passed" : "Required"}</em>
    </div>
  );
}

function EvidenceItem({
  id,
  kind,
  label,
}: {
  id: string;
  kind: string;
  label: string;
}) {
  return (
    <div className="evidence-item">
      <div
        className="evidence-visual"
        role="img"
        aria-label={`${kind} evidence: ${label}`}
        style={{
          backgroundImage: `linear-gradient(180deg, rgba(18,60,46,0.08), rgba(18,60,46,0.42)), url("/api/v1/evidence?id=${encodeURIComponent(id)}")`,
        }}
      >
        <span>{kind === "Before" ? "01" : "02"}</span>
        <em>Evidence</em>
      </div>
      <div>
        <span className="status-pill blue">{kind}</span>
        <strong>{label}</strong>
        <small>{id} · Basement · server confirmed</small>
      </div>
    </div>
  );
}

function TimelineItem({
  date,
  title,
  text,
  tone,
}: {
  date: string;
  title: string;
  text: string;
  tone: string;
}) {
  return (
    <div className="timeline-item">
      <div>
        <span className={tone} />
      </div>
      <div>
        <small>{date}</small>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function titleForView(view: View) {
  const labels: Record<View, string> = {
    control: "Control Tower",
    requests: "Service Request",
    schedule: "Schedule",
    jobs: "Technician Job",
    properties: "Property Intelligence",
    exceptions: "Exceptions",
    playbooks: "Playbooks",
    analytics: "Analytics",
    audit: "Audit",
    settings: "Settings",
    technician: "Technician Job",
    proof: "Service Proof",
  };
  return labels[view];
}

function workflowStage(snapshot: WorkflowSnapshot) {
  if (snapshot.completed) return "Completed";
  if (snapshot.checkedIn) return "In progress";
  if (snapshot.scheduled) return "Scheduled";
  if (snapshot.triageStatus === "APPROVED") return "Triage approved";
  if (snapshot.triageStatus === "PROPOSED") return "Awaiting approval";
  return "New request";
}

function triageLabel(status: WorkflowSnapshot["triageStatus"]) {
  if (status === "APPROVED") return "Human approved";
  if (status === "PROPOSED") return "AI proposal · review";
  return "New request";
}

function riskReviewLabel(status: WorkflowSnapshot["riskReview"]) {
  if (status === "CLEAR") return "Reviewed clear";
  if (status === "UNRESOLVED") return "Unresolved";
  return "Not reviewed";
}

function outcomeLabel(outcome: WorkflowSnapshot["outcome"]) {
  if (outcome === "RESOLVED") return "Resolved";
  if (outcome === "PARTIALLY_RESOLVED") return "Partially resolved";
  if (outcome === "UNRESOLVED") return "Unresolved";
  if (outcome === "CUSTOMER_UNREACHABLE") return "Customer unreachable";
  if (outcome === "RESERVICE_REQUIRED") return "Reservice required";
  if (outcome === "PENDING_VERIFICATION") return "Pending verification";
  return "Not yet assessed";
}

function riskLabel(score: number) {
  if (score >= 65) return "High";
  if (score >= 35) return "Moderate";
  return "Low";
}

function humanize(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/, (character) => character.toUpperCase());
}

function commandLabel(type: WorkflowCommand["type"]) {
  const labels: Record<WorkflowCommand["type"], string> = {
    RUN_TRIAGE: "Generating triage proposal",
    APPROVE_TRIAGE: "Recording human approval",
    APPROVE_SCHEDULE: "Approving appointment",
    CHECK_IN: "Checking in",
    SET_CHECKLIST_STEP: "Saving checklist step",
    ADD_OBSERVATION: "Saving observation",
    REVIEW_RISK: "Saving risk review",
    COMPLETE_JOB: "Completing job transaction",
    SEND_PROOF: "Queueing Service Proof delivery",
    VERIFY_OUTCOME: "Recording independent outcome verification",
    RECORD_RESERVICE: "Linking reservice cost to the original job",
    RESOLVE_EXCEPTION: "Resolving exception",
    RESET_DEMO: "Restarting demo workflow",
  };
  return labels[type];
}

function isJournaledCommand(command: WorkflowCommand) {
  return (
    isDraftOnlyCommand(command) ||
    command.type === "COMPLETE_JOB" ||
    command.type === "SEND_PROOF"
  );
}

function journalKind(
  command: WorkflowCommand,
): "DRAFT_COMMAND" | "COMPLETION_INTENT" | "PROOF_DELIVERY" {
  if (command.type === "COMPLETE_JOB") return "COMPLETION_INTENT";
  if (command.type === "SEND_PROOF") return "PROOF_DELIVERY";
  return "DRAFT_COMMAND";
}

function offlineCommandPayload(command: WorkflowCommand) {
  const payload = { ...command } as Record<string, unknown>;
  delete payload.commandId;
  delete payload.expectedVersion;
  return payload;
}

function activeJournalOperations(operations: readonly JournalOperation[]) {
  return operations.filter(
    (operation) =>
      operation.status !== "CONFIRMED" &&
      operation.status !== "CANCELLED",
  );
}

function countJournalPending(operations: readonly JournalOperation[]) {
  return activeJournalOperations(operations).length;
}

function isRecoverableJournalOperation(operation: JournalOperation) {
  return (
    operation.status === "AUTH_BLOCKED" ||
    operation.status === "NEEDS_ACTION" ||
    operation.status === "RETRY_PAUSED"
  );
}

function canSafelyDiscardJournalOperation(operation: JournalOperation) {
  return (
    (operation.status === "AUTH_BLOCKED" ||
      operation.status === "NEEDS_ACTION") &&
    operation.lastError?.commitState === "NOT_APPLIED"
  );
}

function requireConfirmedBaseVersion(snapshot: WorkflowSnapshot | null) {
  if (!snapshot) {
    throw new Error(
      "Critical offline work requires a server-confirmed base snapshot.",
    );
  }
  return snapshot.version;
}

function requestJournalRuntimeAction(
  eventName: "fieldproof:journal-resume" | "fieldproof:journal-discard",
  detail: {
    scope: JournalScope;
    operationId: string;
    expectedRevision: number;
  },
) {
  const requestId = crypto.randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("fieldproof:journal-result", onResult);
      reject(new Error("The offline recovery runtime did not respond."));
    }, 30_000);
    function onResult(event: Event) {
      const result = (
        event as CustomEvent<{
          requestId?: string;
          ok?: boolean;
          value?: unknown;
          error?: string;
        }>
      ).detail;
      if (result?.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("fieldproof:journal-result", onResult);
      if (result.ok) resolve(result.value);
      else reject(new Error(result.error ?? "Offline recovery failed."));
    }
    window.addEventListener("fieldproof:journal-result", onResult);
    window.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { ...detail, requestId },
      }),
    );
  });
}

async function replayJournalOperation(
  store: OfflineJournalStore,
  executor: OfflineSyncExecutor,
  scope: JournalScope,
  operationId: string,
  initialServerVersion: number,
) {
  let serverVersion = initialServerVersion;
  let result: ReplayExecutionResult | null = null;

  // A second field action can be appended after an in-flight replay has made
  // its final plan but before that replay's promise settles. Re-check the
  // caller's exact operation and start a fresh pass when needed; joining any
  // successful scope replay is not sufficient proof that this action landed.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = await store.get(scope, operationId);
    if (!before || isSettledJournalOperation(before)) {
      return { operation: before, result };
    }

    result = await executor.replay(scope, serverVersion);
    serverVersion = result.serverVersion;

    const after = await store.get(scope, operationId);
    if (!after || isSettledJournalOperation(after)) {
      return { operation: after, result };
    }
    if (
      result.stoppedBecause !== "DRAINED" &&
      result.stoppedBecause !== "LIMIT_REACHED"
    ) {
      return { operation: after, result };
    }
  }

  return {
    operation: await store.get(scope, operationId),
    result,
  };
}

function isSettledJournalOperation(operation: JournalOperation) {
  return (
    operation.status === "CONFIRMED" ||
    operation.status === "NEEDS_ACTION" ||
    operation.status === "AUTH_BLOCKED" ||
    operation.status === "RETRY_PAUSED" ||
    operation.status === "RETRY_WAIT" ||
    operation.status === "CANCELLED"
  );
}

function journalResultMessage(stoppedBecause: string) {
  switch (stoppedBecause) {
    case "DEFERRED":
      return "Saved locally · retry is scheduled with backoff";
    case "BLOCKED":
      return "Saved locally · a dependency, sign-in, or conflict needs attention";
    case "FAILED":
      return "Saved locally · server confirmation failed and remains recoverable";
    case "ABORTED":
      return "Saved locally · synchronization was interrupted";
    case "LIMIT_REACHED":
      return "Some local work remains · retry synchronization";
    default:
      return "Saved locally · awaiting server confirmation";
  }
}

function isDraftOnlyCommand(command: WorkflowCommand) {
  return (
    command.type === "CHECK_IN" ||
    command.type === "SET_CHECKLIST_STEP" ||
    command.type === "ADD_OBSERVATION" ||
    command.type === "REVIEW_RISK"
  );
}

function formatTime(value: string | number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(value: string | number | null) {
  if (value === null) return "not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not scheduled";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "Pending";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value / 100);
}

function initials(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function safeJsonArray(value: string | null | undefined) {
  if (!value) return [] as Array<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object",
        )
      : [];
  } catch {
    return [];
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The workflow could not be loaded.";
}

class ResponseError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
