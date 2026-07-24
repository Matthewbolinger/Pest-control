"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { huntleyCandidates } from "@/packages/domain";
import { applyWorkflowCommand } from "@/packages/application/workflow";
import type {
  EvidenceRecord,
  WorkflowCommand,
  WorkflowSnapshot,
} from "@/packages/application/workflow";

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

type QueuedCommand = {
  commandId: string;
  command: WorkflowCommand;
  queuedAt: number;
};

type QueuedEvidence = {
  idempotencyKey: string;
  file: Blob;
  fileName: string;
  fileType: string;
  queuedAt: number;
};

const OFFLINE_DB = "fieldproof-offline";
const OFFLINE_DB_VERSION = 2;
const SNAPSHOT_KEY = "WF-JOB-2048";

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
  { id: "playbooks", label: "Playbooks", mark: "PB", enabled: false },
  { id: "analytics", label: "Analytics", mark: "AN", enabled: false },
  { id: "audit", label: "Audit", mark: "AU", enabled: true },
  { id: "settings", label: "Settings", mark: "ST", enabled: false },
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
  const [onlineTick, setOnlineTick] = useState(0);
  const [confirmedVersion, setConfirmedVersion] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const snapshotRef = useRef<WorkflowSnapshot | null>(null);
  const confirmedSnapshotRef = useRef<WorkflowSnapshot | null>(null);
  const offlineLoadedRef = useRef(false);
  const syncingRef = useRef(false);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

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
        if (offlineLoadedRef.current) void saveSnapshot(body.data);
        setSelectedCandidateDraft(
          body.data.selectedCandidateId ?? huntleyCandidates[0].id,
        );
        setSync({
          kind: "synced",
          message: `Server confirmed · workflow v${body.data.version}`,
        });
        void refreshAudit();
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
    [refreshAudit],
  );

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        const offline = await readOfflineState();
        if (cancelled) return;
        if (offline.snapshot) {
          let localDraft = offline.snapshot;
          for (const queued of offline.commands) {
            if (!isDraftOnlyCommand(queued.command)) continue;
            try {
              localDraft = applyWorkflowCommand(
                localDraft,
                queued.command,
                localDraft.updatedAt,
              );
            } catch {
              break;
            }
          }
          setSnapshot(localDraft);
          snapshotRef.current = localDraft;
          confirmedSnapshotRef.current = offline.snapshot;
          setConfirmedVersion(offline.snapshot.version);
          setSelectedCandidateDraft(
            localDraft.selectedCandidateId ?? huntleyCandidates[0].id,
          );
        }
        setPendingCount(offline.pendingCount);
        offlineLoadedRef.current = true;
        setOfflineReady(true);
        await refreshWorkflow(Boolean(offline.snapshot));
        if (offline.pendingCount > 0 && navigator.onLine) {
          setOnlineTick((value) => value + 1);
        }
      } catch {
        offlineLoadedRef.current = true;
        setOfflineReady(false);
        await refreshWorkflow();
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkflow]);

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
      setBusy(command.type);
      setSync({ kind: "pending", message: `${commandLabel(command.type)}…` });
      try {
        const response = await fetch("/api/v1/workflow", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "Idempotency-Key": command.commandId,
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
        if (offlineLoadedRef.current) void saveSnapshot(body.data);
        await removeQueuedCommand(command.commandId);
        setPendingCount(await countPendingWork());
        setSync({
          kind: "synced",
          message: `Server confirmed · workflow v${body.data.version}`,
        });
        void refreshAudit();
        return body.data;
      } catch (error) {
        if (error instanceof ResponseError && error.status < 500) {
          setSync({ kind: "error", message: error.message });
          return null;
        }
        await queueCommand(command);
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
        setPendingCount(await countPendingWork());
        setSync({
          kind: navigator.onLine ? "pending" : "offline",
          message:
            "Change saved on this device · not applied until the server confirms it",
        });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refreshAudit, refreshWorkflow],
  );

  const uploadEvidence = useCallback(
    async (
      file: File,
      idempotencyKey = crypto.randomUUID(),
      queueOnFailure = true,
    ): Promise<WorkflowSnapshot | null> => {
      setBusy("UPLOAD_EVIDENCE");
      setSync({ kind: "pending", message: "Uploading evidence…" });
      const formData = new FormData();
      formData.set("file", file);
      formData.set("jobId", "JOB-2048");
      formData.set("propertyId", "PROP-118");
      formData.set("zoneId", "ZONE-BASEMENT");
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
        if (offlineLoadedRef.current) void saveSnapshot(body.data.snapshot);
        await removeQueuedEvidence(idempotencyKey);
        setPendingCount(await countPendingWork());
        setSync({
          kind: "synced",
          message: `Evidence confirmed by server · workflow v${body.data.snapshot.version}`,
        });
        void refreshAudit();
        return body.data.snapshot;
      } catch (error) {
        if (error instanceof ResponseError && error.status < 500) {
          setSync({
            kind: "error",
            message: `${error.message} Evidence was not counted.`,
          });
          return null;
        }
        if (queueOnFailure) {
          await queueEvidence({
            idempotencyKey,
            file,
            fileName: file.name,
            fileType: file.type,
            queuedAt: Date.now(),
          });
          setPendingCount(await countPendingWork());
        }
        setSync({
          kind: navigator.onLine ? "pending" : "offline",
          message:
            "Evidence is held on this device · it is not counted until upload succeeds",
        });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refreshAudit],
  );

  const syncPendingWork = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine || !offlineLoadedRef.current) {
      return;
    }
    syncingRef.current = true;
    try {
      const pending = await readPendingWork();
      if (pending.commands.length + pending.evidence.length === 0) return;
      setSync({
        kind: "pending",
        message: `Retrying ${pending.commands.length + pending.evidence.length} pending item(s)…`,
      });
      let current = await refreshWorkflow(true);
      for (const queued of pending.commands) {
        if (!current) break;
        // Retry the exact command body. Changing expectedVersion while reusing a
        // commandId would violate the server's idempotency receipt contract.
        const result = await dispatchCommand(queued.command);
        if (!result) break;
        current = result;
      }
      for (const queued of pending.evidence) {
        const file = new File([queued.file], queued.fileName, {
          type: queued.fileType,
        });
        const result = await uploadEvidence(
          file,
          queued.idempotencyKey,
          false,
        );
        if (!result) break;
        current = result;
      }
      setPendingCount(await countPendingWork());
    } finally {
      syncingRef.current = false;
    }
  }, [dispatchCommand, refreshWorkflow, uploadEvidence]);

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

  async function createAndUploadSampleEvidence() {
    const number = (snapshotRef.current?.evidenceCount ?? 0) + 1;
    try {
      const file = await createSamplePng(number);
      await uploadEvidence(file);
    } catch (error) {
      setSync({ kind: "error", message: errorMessage(error) });
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
      snapshot.evidenceCount >= 2 &&
      snapshot.observation &&
      snapshot.riskReview !== "NOT_REVIEWED" &&
      !snapshot.completed,
  );
  const hasLocalDraft = Boolean(
    pendingCount > 0 &&
      confirmedVersion !== null &&
      snapshot?.version !== confirmedVersion,
  );

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
            onAddSampleEvidence={() => void createAndUploadSampleEvidence()}
            onAddObservation={() =>
              void runCommand("ADD_OBSERVATION", {
                note: "Small dark droppings observed along north basement sill plate.",
              })
            }
            onReviewRisk={(unresolved) =>
              void runCommand("REVIEW_RISK", { unresolved })
            }
            onComplete={async () => {
              const result = await runCommand("COMPLETE_JOB");
              if (result?.proofGenerated) go("proof");
            }}
            onEvidenceFile={(file) => uploadEvidence(file)}
          />
        );
      case "properties":
        return <PropertyView snapshot={snapshot} />;
      case "exceptions":
        return (
          <ExceptionsView
            snapshot={snapshot}
            busy={busy ?? (pendingCount > 0 ? "PENDING_SYNC" : null)}
            onResolve={() => void runCommand("RESOLVE_EXCEPTION")}
          />
        );
      case "audit":
        return <AuditView items={audit} />;
      case "proof":
        return (
          <ProofView
            snapshot={snapshot}
            candidate={selected}
            busy={busy ?? (pendingCount > 0 ? "PENDING_SYNC" : null)}
            onSend={() => void runCommand("SEND_PROOF")}
          />
        );
      case "playbooks":
      case "analytics":
      case "settings":
        return <ComingSoonView area={titleForView(view)} />;
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
            <strong>Northstar Pest</strong>
            <span>Authenticated pilot tenant</span>
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
              <strong>Pilot operator</strong>
            </div>
            <div className="user-avatar" aria-label="Authenticated user">
              PO
            </div>
          </div>
        </header>
        {pendingCount > 0 ? (
          <div className="pending-banner" role="status">
            <strong>{pendingCount} item(s) waiting for server confirmation.</strong>
            <span>
              {hasLocalDraft
                ? "Field edits are local draft state; evidence counts, completion, and proof remain server-only."
                : "Queued work is not reflected in the authoritative state until a retry succeeds."}
            </span>
            <button
              className="text-button"
              disabled={!navigator.onLine}
              onClick={() => void syncPendingWork()}
            >
              Retry now
            </button>
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
  onAddSampleEvidence,
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
  onAddSampleEvidence: () => void;
  onAddObservation: () => void;
  onReviewRisk: (unresolved: boolean) => void;
  onComplete: () => void;
  onEvidenceFile: (file: File) => Promise<WorkflowSnapshot | null>;
}) {
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
                      snapshot.completed ||
                      Boolean(busy)
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
                {snapshot.evidence.map((record, index) => (
                  <EvidenceItem
                    key={record.id}
                    id={record.id}
                    kind={index === 0 ? "Before" : "Detail"}
                    label={
                      index === 0
                        ? "Basement north wall overview"
                        : "North sill-plate detail"
                    }
                  />
                ))}
                {snapshot.evidenceCount < 2 ? (
                  <button
                    className="evidence-empty"
                    onClick={onAddSampleEvidence}
                    disabled={
                      !snapshot.checkedIn ||
                      snapshot.completed ||
                      Boolean(busy)
                    }
                  >
                    <span>+</span>
                    <strong>
                      Create & upload sample{" "}
                      {snapshot.evidenceCount === 0 ? "overview" : "detail"} PNG
                    </strong>
                    <small>
                      A real image blob is uploaded; only server success counts
                    </small>
                  </button>
                ) : null}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onEvidenceFile(file);
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
                Choose a photo file
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
                <button
                  className="observation-empty"
                  disabled={
                    !snapshot.checkedIn ||
                    snapshot.completed ||
                    Boolean(busy)
                  }
                  onClick={onAddObservation}
                >
                  <span>+</span>
                  <strong>Record sample observation</strong>
                  <small>Basement · rodent evidence · north wall</small>
                </button>
              ) : (
                <div className="observation-record">
                  <div>
                    <span className="status-pill blue">Rodent evidence</span>
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
                label="2 uploaded evidence items"
                passed={snapshot.evidenceCount >= 2}
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
            <button
              className="button primary full"
              disabled={!completionReady || Boolean(busy)}
              onClick={onComplete}
            >
              Complete job & generate proof
            </button>
            <p className="approval-note">
              No completion or report appears until the server commits the full
              outcome transaction.
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
  busy,
  onSend,
}: {
  snapshot: WorkflowSnapshot;
  candidate: (typeof huntleyCandidates)[number];
  busy: string | null;
  onSend: () => void;
}) {
  if (!snapshot.proofGenerated) {
    return <ComingSoonView area="Service Proof awaiting server completion" />;
  }
  const unresolved = snapshot.riskReview === "UNRESOLVED";
  return (
    <div className="proof-page page-stack">
      <section className="page-intro no-print">
        <div>
          <div className="breadcrumb">
            Jobs / {snapshot.jobId} / <strong>Service Proof</strong>
          </div>
          <h1>Server-confirmed report</h1>
          <p>Generated only after the atomic completion gate passed.</p>
        </div>
        <div className="intro-actions">
          <button className="button secondary" onClick={() => window.print()}>
            Print / Save PDF
          </button>
          <button
            className="button primary"
            onClick={onSend}
            disabled={snapshot.proofSent || Boolean(busy)}
          >
            {snapshot.proofSent
              ? "Delivery queued"
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
            <p className="kicker">Service completed</p>
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
            <strong>{candidate.startsAt}</strong>
          </div>
          <div>
            <span>Outcome</span>
            <strong>{outcomeLabel(snapshot.outcome)}</strong>
          </div>
          <div>
            <span>Playbook</span>
            <strong>ROD v3.2</strong>
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
            {snapshot.evidence.map((record, index) => (
              <EvidenceItem
                key={record.id}
                id={record.id}
                kind={index === 0 ? "Before" : "Detail"}
                label={
                  index === 0
                    ? "Basement north wall overview"
                    : "North sill-plate detail"
                }
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
            <p className="kicker">Follow-up</p>
            <strong>
              {snapshot.followUpCreated ? "Follow-up created" : "None required"}
            </strong>
            <span>Outcome: {outcomeLabel(snapshot.outcome)}</span>
          </div>
        </section>
      </article>
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
  onResolve,
}: {
  snapshot: WorkflowSnapshot;
  busy: string | null;
  onResolve: () => void;
}) {
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
                  <span className="status-pill green">Resolved</span>
                ) : (
                  <button
                    className="button primary"
                    disabled={Boolean(busy)}
                    onClick={onResolve}
                  >
                    Assign & resolve
                  </button>
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
  return "Pending";
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
    RESOLVE_EXCEPTION: "Resolving exception",
    RESET_DEMO: "Restarting demo workflow",
  };
  return labels[type];
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

async function createSamplePng(number: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 640;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot create sample evidence.");
  context.fillStyle = number === 1 ? "#dce5dd" : "#d8cec0";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#123c2e";
  context.fillRect(0, 0, canvas.width, 92);
  context.fillStyle = "#ffffff";
  context.font = "bold 32px sans-serif";
  context.fillText(
    number === 1 ? "Basement north wall overview" : "North sill-plate detail",
    40,
    58,
  );
  context.strokeStyle = "#50685b";
  context.lineWidth = 14;
  context.strokeRect(150, 180, 660, 300);
  context.fillStyle = "#17221d";
  context.font = "24px sans-serif";
  context.fillText("FieldProof pilot evidence", 40, 590);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Sample evidence could not be encoded.");
  return new File([blob], `fieldproof-sample-${number}.png`, {
    type: "image/png",
  });
}

function openOfflineDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("drafts")) {
        db.createObjectStore("drafts");
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots");
      }
      if (!db.objectStoreNames.contains("pendingCommands")) {
        db.createObjectStore("pendingCommands", { keyPath: "commandId" });
      }
      if (!db.objectStoreNames.contains("pendingEvidence")) {
        db.createObjectStore("pendingEvidence", {
          keyPath: "idempotencyKey",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function readOfflineState() {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction(
      ["snapshots", "pendingCommands", "pendingEvidence"],
      "readonly",
    );
    const snapshotRequest = tx
      .objectStore("snapshots")
      .get(SNAPSHOT_KEY) as IDBRequest<WorkflowSnapshot | undefined>;
    const commandRequest = tx
      .objectStore("pendingCommands")
      .getAll() as IDBRequest<QueuedCommand[]>;
    const evidenceCountRequest = tx.objectStore("pendingEvidence").count();
    const [snapshot, commands, evidenceCount] = await Promise.all([
      idbRequest(snapshotRequest),
      idbRequest(commandRequest),
      idbRequest(evidenceCountRequest),
    ]);
    await transactionComplete(tx);
    return {
      snapshot: snapshot ?? null,
      commands: commands.sort((a, b) => a.queuedAt - b.queuedAt),
      pendingCount: commands.length + evidenceCount,
    };
  } finally {
    db.close();
  }
}

async function saveSnapshot(snapshot: WorkflowSnapshot) {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction("snapshots", "readwrite");
    tx.objectStore("snapshots").put(snapshot, SNAPSHOT_KEY);
    await transactionComplete(tx);
  } finally {
    db.close();
  }
}

async function queueCommand(command: WorkflowCommand) {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction("pendingCommands", "readwrite");
    const record: QueuedCommand = {
      commandId: command.commandId,
      command,
      queuedAt: Date.now(),
    };
    tx.objectStore("pendingCommands").put(record);
    await transactionComplete(tx);
  } finally {
    db.close();
  }
}

async function removeQueuedCommand(commandId: string) {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction("pendingCommands", "readwrite");
    tx.objectStore("pendingCommands").delete(commandId);
    await transactionComplete(tx);
  } finally {
    db.close();
  }
}

async function queueEvidence(record: QueuedEvidence) {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction("pendingEvidence", "readwrite");
    tx.objectStore("pendingEvidence").put(record);
    await transactionComplete(tx);
  } finally {
    db.close();
  }
}

async function removeQueuedEvidence(idempotencyKey: string) {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction("pendingEvidence", "readwrite");
    tx.objectStore("pendingEvidence").delete(idempotencyKey);
    await transactionComplete(tx);
  } finally {
    db.close();
  }
}

async function readPendingWork() {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction(
      ["pendingCommands", "pendingEvidence"],
      "readonly",
    );
    const commandRequest = tx
      .objectStore("pendingCommands")
      .getAll() as IDBRequest<QueuedCommand[]>;
    const evidenceRequest = tx
      .objectStore("pendingEvidence")
      .getAll() as IDBRequest<QueuedEvidence[]>;
    const [commands, evidence] = await Promise.all([
      idbRequest(commandRequest),
      idbRequest(evidenceRequest),
    ]);
    await transactionComplete(tx);
    return {
      commands: commands.sort((a, b) => a.queuedAt - b.queuedAt),
      evidence: evidence.sort((a, b) => a.queuedAt - b.queuedAt),
    };
  } finally {
    db.close();
  }
}

async function countPendingWork() {
  const db = await openOfflineDb();
  try {
    const tx = db.transaction(
      ["pendingCommands", "pendingEvidence"],
      "readonly",
    );
    const [commands, evidence] = await Promise.all([
      idbRequest(tx.objectStore("pendingCommands").count()),
      idbRequest(tx.objectStore("pendingEvidence").count()),
    ]);
    await transactionComplete(tx);
    return commands + evidence;
  } finally {
    db.close();
  }
}
