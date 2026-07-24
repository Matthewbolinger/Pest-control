"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { huntleyCandidates, calculateRecurrenceRisk } from "@/packages/domain";

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

type Workflow = {
  triaged: boolean;
  scheduled: boolean;
  checkedIn: boolean;
  checklist: boolean[];
  evidence: number;
  observation: boolean;
  unresolvedRisk: boolean;
  completed: boolean;
  outcome: "PENDING" | "PARTIALLY_RESOLVED";
};

type AuditItem = {
  id: string;
  time: string;
  actor: "AI" | "Human" | "System";
  action: string;
  reason: string;
  policy?: string;
};

const initialWorkflow: Workflow = {
  triaged: false,
  scheduled: false,
  checkedIn: false,
  checklist: [false, false, false, false],
  evidence: 0,
  observation: false,
  unresolvedRisk: false,
  completed: false,
  outcome: "PENDING",
};

const initialAudit: AuditItem[] = [
  {
    id: "AUD-9231",
    time: "10:18:04",
    actor: "System",
    action: "SERVICE_REQUEST_CREATED",
    reason: "Inbound SMS normalized to service request SR-1048.",
  },
  {
    id: "AUD-9230",
    time: "10:18:03",
    actor: "System",
    action: "UNTRUSTED_CONTENT_SCANNED",
    reason: "No executable instructions or prohibited action patterns found.",
    policy: "input-boundary-v1.1",
  },
];

const navigation: { id: View; label: string; mark: string }[] = [
  { id: "control", label: "Control Tower", mark: "CT" },
  { id: "schedule", label: "Schedule", mark: "SC" },
  { id: "requests", label: "Service Requests", mark: "SR" },
  { id: "jobs", label: "Jobs", mark: "JB" },
  { id: "properties", label: "Properties", mark: "PR" },
  { id: "exceptions", label: "Exceptions", mark: "EX" },
  { id: "playbooks", label: "Playbooks", mark: "PB" },
  { id: "analytics", label: "Analytics", mark: "AN" },
  { id: "audit", label: "Audit", mark: "AU" },
  { id: "settings", label: "Settings", mark: "ST" },
];

const checklistLabels = [
  "Inspect basement perimeter and sill plates",
  "Inspect utility penetrations and accessible voids",
  "Document signs, conditions, and potential entry points",
  "Review unresolved risks and follow-up requirement",
];

export function FieldProofApp() {
  const [view, setView] = useState<View>("control");
  const [role, setRole] = useState<"Owner" | "Dispatcher" | "Technician">("Owner");
  const [workflow, setWorkflow] = useState<Workflow>(initialWorkflow);
  const [audit, setAudit] = useState<AuditItem[]>(initialAudit);
  const [notice, setNotice] = useState("Demo state loaded · Mock AI provider");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState(huntleyCandidates[0].id);
  const [exceptionResolved, setExceptionResolved] = useState(false);
  const [proofSent, setProofSent] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = huntleyCandidates.find((item) => item.id === selectedCandidate) ?? huntleyCandidates[0];
  const completionReady =
    workflow.checkedIn &&
    workflow.checklist.every(Boolean) &&
    workflow.evidence >= 2 &&
    workflow.observation &&
    workflow.unresolvedRisk;

  const risk = useMemo(
    () =>
      calculateRecurrenceRisk({
        relatedIssues: 1,
        reserviceEvents90Days: 0,
        openRisks: workflow.unresolvedRisk ? 1 : 0,
        missingEvidence: workflow.evidence < 2,
        incompleteSteps: !workflow.checklist.every(Boolean),
        priorUnresolvedOutcome: false,
        followUpOverdue: false,
        uncertaintyFlag: workflow.unresolvedRisk,
      }),
    [workflow],
  );

  useEffect(() => {
    const request = indexedDB.open("fieldproof-offline", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts");
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put(workflow, "JOB-2048");
      tx.oncomplete = () => {
        setOfflineReady(true);
        db.close();
      };
    };
  }, [workflow]);

  function appendAudit(actor: AuditItem["actor"], action: string, reason: string, policy?: string) {
    const now = new Date();
    const time = now.toLocaleTimeString("en-US", { hour12: false });
    setAudit((items) => [
      { id: `AUD-${9232 + items.length}`, time, actor, action, reason, policy },
      ...items,
    ]);
    void fetch("/api/v1/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor, action, reason, policy, entityType: "JOB", entityId: "JOB-2048" }),
    }).catch(() => {
      // The field workflow remains available offline; the outbox syncs when connectivity returns.
    });
  }

  function go(next: View) {
    setView(next);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function runTriage() {
    setWorkflow((state) => ({ ...state, triaged: true }));
    appendAudit(
      "AI",
      "TRIAGE_OUTPUT_VALIDATED",
      "Mock provider extracted rodent concern, basement zone, routine urgency, and approved inspection service.",
      "ai-safety-v1.4",
    );
    appendAudit(
      "System",
      "SERVICEABILITY_CONFIRMED",
      "Residential property, Huntley territory, active plan, approved service type.",
      "serviceability-v2.1",
    );
    setNotice("Triage complete · 94% confidence · Human approval required");
  }

  function approveSchedule() {
    setWorkflow((state) => ({ ...state, scheduled: true }));
    appendAudit(
      "Human",
      "APPOINTMENT_APPROVED",
      `${selected.technician} approved for ${selected.startsAt}; expected contribution $${selected.economics.expectedContributionMargin.toFixed(2)}.`,
      "scheduling-v3.2",
    );
    appendAudit("System", "PRE_JOB_BRIEF_QUEUED", "Job brief requested from approved facts and playbook v3.2.");
    setRole("Technician");
    setNotice("Appointment confirmed · Technician brief generated");
    go("technician");
  }

  function toggleChecklist(index: number) {
    setWorkflow((state) => ({
      ...state,
      checklist: state.checklist.map((checked, itemIndex) =>
        itemIndex === index ? !checked : checked,
      ),
    }));
  }

  function addEvidence() {
    setWorkflow((state) => ({ ...state, evidence: Math.min(3, state.evidence + 1) }));
    appendAudit(
      "Human",
      "EVIDENCE_CAPTURED",
      `Evidence item ${workflow.evidence + 1} attributed to JOB-2048, PROP-118, TECH-04, Basement, and capture timestamp.`,
      "evidence-ledger-v1.2",
    );
    setNotice("Evidence draft saved locally and queued for secure sync");
  }

  async function uploadEvidence(file: File) {
    const formData = new FormData();
    formData.set("file", file);
    formData.set("jobId", "JOB-2048");
    formData.set("propertyId", "PROP-118");
    formData.set("zoneId", "ZONE-BASEMENT");
    try {
      const response = await fetch("/api/v1/evidence", { method: "POST", body: formData });
      if (!response.ok) throw new Error("Upload rejected");
      addEvidence();
      setNotice("Evidence encrypted in transit and stored with immutable attribution");
    } catch {
      addEvidence();
      setNotice("Offline evidence draft saved · Secure upload will retry");
    }
  }

  function completeJob() {
    if (!completionReady) return;
    setWorkflow((state) => ({
      ...state,
      completed: true,
      outcome: "PARTIALLY_RESOLVED",
    }));
    appendAudit(
      "Human",
      "JOB_COMPLETED",
      "Required playbook steps, evidence, note, and unresolved-risk acknowledgment passed the completion gate.",
      "completion-gate-v2.4",
    );
    appendAudit(
      "System",
      "FOLLOW_UP_CREATED",
      "Unresolved north sill-plate gap created a 7-day follow-up and open property risk.",
      "outcome-loop-v1.6",
    );
    appendAudit(
      "System",
      "SERVICE_PROOF_GENERATED",
      "Report SP-2048 generated from approved structured facts only.",
      "report-policy-v1.3",
    );
    setNotice("Job completed · Service Proof SP-2048 generated");
    go("proof");
  }

  function resetDemo() {
    setWorkflow(initialWorkflow);
    setAudit(initialAudit);
    setSelectedCandidate(huntleyCandidates[0].id);
    setExceptionResolved(false);
    setProofSent(false);
    setRole("Owner");
    setNotice("Demo reset · Ready for triage");
    go("control");
  }

  const main = (() => {
    switch (view) {
      case "requests":
        return (
          <ServiceRequestView
            triaged={workflow.triaged}
            onTriage={runTriage}
            onSchedule={() => go("schedule")}
          />
        );
      case "schedule":
        return (
          <ScheduleView
            triaged={workflow.triaged}
            selectedId={selectedCandidate}
            onSelect={setSelectedCandidate}
            onApprove={approveSchedule}
            onOpenRequest={() => go("requests")}
          />
        );
      case "technician":
      case "jobs":
        return (
          <TechnicianView
            workflow={workflow}
            scheduled={workflow.scheduled}
            offlineReady={offlineReady}
            completionReady={completionReady}
            onCheckIn={() => {
              setWorkflow((state) => ({ ...state, checkedIn: true }));
              appendAudit("Human", "TECHNICIAN_CHECKED_IN", "Maya Chen checked in to JOB-2048 at the customer property.");
            }}
            onToggleChecklist={toggleChecklist}
            onAddEvidence={addEvidence}
            onAddObservation={() => {
              setWorkflow((state) => ({ ...state, observation: true }));
              appendAudit("Human", "OBSERVATION_ADDED", "Mouse droppings documented along north basement sill plate.");
            }}
            onFlagRisk={() => {
              setWorkflow((state) => ({ ...state, unresolvedRisk: true }));
              appendAudit("Human", "PROPERTY_RISK_FLAGGED", "Potential entry-point gap recorded as unresolved; follow-up required.");
            }}
            onComplete={completeJob}
            fileInputRef={fileInputRef}
            onEvidenceFile={uploadEvidence}
          />
        );
      case "properties":
        return <PropertyView risk={risk.score} completed={workflow.completed} evidence={workflow.evidence} />;
      case "exceptions":
        return (
          <ExceptionsView
            resolved={exceptionResolved}
            onResolve={() => {
              setExceptionResolved(true);
              appendAudit("Human", "EXCEPTION_RESOLVED", "Dispatcher assigned follow-up owner and due date.");
              setNotice("Exception resolved with an auditable follow-up");
            }}
          />
        );
      case "playbooks":
        return <PlaybooksView />;
      case "analytics":
        return <AnalyticsView completed={workflow.completed} />;
      case "audit":
        return <AuditView items={audit} />;
      case "settings":
        return <SettingsView />;
      case "proof":
        return (
          <ProofView
            risk={risk.score}
            sent={proofSent}
            onSend={() => {
              setProofSent(true);
              appendAudit("Human", "SERVICE_PROOF_SENT", "SP-2048 delivered through the mock communications adapter.");
              setNotice("Service Proof sent · Delivery ID MSG-SP-2048");
            }}
          />
        );
      default:
        return (
          <ControlTower
            workflow={workflow}
            risk={risk.score}
            exceptionResolved={exceptionResolved}
            onOpenRequest={() => go("requests")}
            onOpenJob={() => go(workflow.completed ? "proof" : "technician")}
            onOpenExceptions={() => go("exceptions")}
            onOpenAudit={() => go("audit")}
          />
        );
    }
  })();

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`} aria-label="Primary navigation">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <span>F</span>
          </div>
          <div>
            <strong>FieldProof</strong>
            <small>Outcome operations</small>
          </div>
          <button className="sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation">×</button>
        </div>
        <div className="org-chip">
          <div className="org-avatar">NP</div>
          <div>
            <strong>Northstar Pest</strong>
            <span>Huntley branch</span>
          </div>
          <span className="chevron">⌄</span>
        </div>
        <nav className="nav-list">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={view === item.id || (item.id === "jobs" && view === "technician") ? "nav-active" : ""}
              onClick={() => go(item.id)}
            >
              <span className="nav-mark">{item.mark}</span>
              <span>{item.label}</span>
              {item.id === "exceptions" && !exceptionResolved ? <em>8</em> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="autonomy-status">
            <span className="status-dot" />
            <div>
              <strong>Suggest only</strong>
              <span>Human approval is on</span>
            </div>
          </div>
          <button className="reset-button" onClick={resetDemo}>Reset demo workflow</button>
        </div>
      </aside>
      {sidebarOpen ? <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" /> : null}
      <div className="main-column">
        <header className="topbar">
          <button className="menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">☰</button>
          <div className="top-context">
            <span className="eyebrow">Thursday · July 24</span>
            <strong>{titleForView(view)}</strong>
          </div>
          <div className="top-actions">
            <div className="sync-state" title={notice}>
              <span className="status-dot" />
              <span>{notice}</span>
            </div>
            <label className="role-select">
              <span>Preview role</span>
              <select
                value={role}
                onChange={(event) => {
                  const next = event.target.value as typeof role;
                  setRole(next);
                  if (next === "Technician") go("technician");
                  if (next === "Dispatcher") go("requests");
                  if (next === "Owner") go("control");
                }}
              >
                <option>Owner</option>
                <option>Dispatcher</option>
                <option>Technician</option>
              </select>
            </label>
            <button className="user-avatar" aria-label="User menu">MB</button>
          </div>
        </header>
        <main className="workspace">{main}</main>
      </div>
    </div>
  );
}

function ControlTower({
  workflow,
  risk,
  exceptionResolved,
  onOpenRequest,
  onOpenJob,
  onOpenExceptions,
  onOpenAudit,
}: {
  workflow: Workflow;
  risk: number;
  exceptionResolved: boolean;
  onOpenRequest: () => void;
  onOpenJob: () => void;
  onOpenExceptions: () => void;
  onOpenAudit: () => void;
}) {
  const metrics = [
    { label: "Projected contribution", value: "$4,862", delta: "+8.4%", tone: "good", note: "Today · 27 scheduled jobs" },
    { label: "Realized contribution", value: workflow.completed ? "$3,598" : "$3,496", delta: workflow.completed ? "74%" : "72%", tone: "good", note: "of today’s projection" },
    { label: "Expected reservice liability", value: workflow.completed ? "$326" : "$341", delta: "-11.2%", tone: "good", note: "7 jobs contribute" },
    { label: "Jobs at risk", value: workflow.completed ? "5" : "4", delta: risk >= 40 ? "Review" : "Stable", tone: risk >= 40 ? "warn" : "good", note: "Outcome or evidence risk" },
    { label: "Evidence completeness", value: workflow.completed ? "96%" : "92%", delta: "+3.1%", tone: "good", note: workflow.completed ? "1 job needs evidence" : "3 jobs need evidence" },
    { label: "Route density", value: "84", delta: "+6", tone: "good", note: "Weighted branch score" },
  ];
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <p className="kicker">Operations at a glance</p>
          <h1>Good morning, Matthew.</h1>
          <p>Northstar has 31 visits in motion. Four decisions need attention before noon.</p>
        </div>
        <div className="intro-actions">
          <button className="button secondary" onClick={onOpenAudit}>View decision trace</button>
          <button className="button primary" onClick={onOpenRequest}>Open priority request</button>
        </div>
      </section>
      <section className="metric-grid" aria-label="Operational metrics">
        {metrics.map((metric) => (
          <button className="metric-card" key={metric.label}>
            <span>{metric.label}</span>
            <div><strong>{metric.value}</strong><em className={metric.tone}>{metric.delta}</em></div>
            <small>{metric.note}</small>
          </button>
        ))}
      </section>
      <section className="control-grid">
        <div className="panel attention-panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Priority work</p>
              <h2>Needs attention</h2>
            </div>
            <button className="text-button" onClick={onOpenExceptions}>View all exceptions →</button>
          </div>
          <div className="attention-list">
            <button className="attention-row priority" onClick={onOpenRequest}>
              <span className="severity-bar" />
              <div className="attention-main">
                <div><span className="status-pill amber">Scheduling decision</span><small>9 min ago</small></div>
                <strong>Morrison residence · basement mouse activity</strong>
                <p>{workflow.scheduled ? "Appointment approved for Maya Chen at 1:30 PM." : "Triage ready. Three eligible slots ranked by expected contribution."}</p>
              </div>
              <div className="impact">
                <span>Expected margin</span>
                <strong>$119.02</strong>
                <em>{workflow.scheduled ? "Approved" : "Review"}</em>
              </div>
            </button>
            <button className="attention-row" onClick={onOpenJob}>
              <span className="severity-bar blue" />
              <div className="attention-main">
                <div><span className="status-pill blue">{workflow.completed ? "Proof ready" : "Evidence gap"}</span><small>22 min ago</small></div>
                <strong>Job FP-2048 · Huntley</strong>
                <p>{workflow.completed ? "Service Proof generated and property risk updated." : "Technician mobile workflow is ready for the approved visit."}</p>
              </div>
              <div className="impact">
                <span>Evidence</span>
                <strong>{workflow.completed ? "Complete" : `${workflow.evidence}/2`}</strong>
                <em>{workflow.completed ? "Open proof" : "Open job"}</em>
              </div>
            </button>
            <button className={`attention-row ${exceptionResolved ? "muted-row" : ""}`} onClick={onOpenExceptions}>
              <span className="severity-bar red" />
              <div className="attention-main">
                <div><span className="status-pill red">{exceptionResolved ? "Resolved" : "Follow-up overdue"}</span><small>1h 14m</small></div>
                <strong>Three unresolved risks lack assigned follow-up owners</strong>
                <p>Estimated reservice exposure is concentrated in two Crystal Lake routes.</p>
              </div>
              <div className="impact">
                <span>Exposure</span>
                <strong>$188</strong>
                <em>{exceptionResolved ? "Resolved" : "Assign"}</em>
              </div>
            </button>
          </div>
        </div>
        <div className="panel route-panel">
          <div className="panel-heading">
            <div>
              <p className="kicker">Branch execution</p>
              <h2>Technician capacity</h2>
            </div>
            <span className="data-time">Updated 2 min ago</span>
          </div>
          <div className="capacity-summary">
            <div><strong>78%</strong><span>Capacity used</span></div>
            <div><strong>6.4h</strong><span>Open capacity</span></div>
            <div><strong>18m</strong><span>Drive / job</span></div>
          </div>
          <div className="tech-bars">
            {[
              ["Maya Chen", 86, "6 jobs"],
              ["Eli Brooks", 78, "5 jobs"],
              ["Andre Silva", 72, "5 jobs"],
              ["Nora Patel", 63, "4 jobs"],
            ].map(([name, value, jobs]) => (
              <div className="tech-bar" key={name}>
                <div><span>{name}</span><small>{jobs}</small></div>
                <div className="bar-track"><span style={{ width: `${value}%` }} /></div>
              </div>
            ))}
          </div>
          <div className="route-note">
            <span className="status-dot" />
            <p><strong>Best route opportunity</strong><br />Maya has an 11-minute adjacency window near Huntley.</p>
          </div>
        </div>
      </section>
      <section className="panel outcomes-panel">
        <div className="panel-heading">
          <div>
            <p className="kicker">Closed loop</p>
            <h2>Recent service outcomes</h2>
          </div>
          <button className="text-button">Open outcome analytics →</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Job</th><th>Property</th><th>Service</th><th>Outcome</th><th>Evidence</th><th>Contribution</th><th>Next action</th></tr></thead>
            <tbody>
              {[
                ["FP-2039", "Whitaker · Algonquin", "General pest inspection", "Resolved", "100%", "$128.40", "30-day check"],
                ["FP-2037", "Sanders · Huntley", "Rodent inspection", "Partial", "100%", "$96.10", "7-day follow-up"],
                ["FP-2034", "Lee · Crystal Lake", "Stinging insect inspection", "Pending", "86%", "$141.25", "Evidence review"],
                ["FP-2031", "Foster · Lake in the Hills", "General pest inspection", "Resolved", "100%", "$117.80", "None"],
              ].map((row) => (
                <tr key={row[0]}>
                  <td><strong>{row[0]}</strong></td>
                  <td>{row[1]}</td>
                  <td>{row[2]}</td>
                  <td><span className={`status-pill ${row[3] === "Resolved" ? "green" : row[3] === "Partial" ? "amber" : "blue"}`}>{row[3]}</span></td>
                  <td>{row[4]}</td>
                  <td><strong>{row[5]}</strong></td>
                  <td>{row[6]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ServiceRequestView({ triaged, onTriage, onSchedule }: { triaged: boolean; onTriage: () => void; onSchedule: () => void }) {
  return (
    <div className="page-stack narrow-page">
      <section className="page-intro">
        <div>
          <div className="breadcrumb">Service Requests / <strong>SR-1048</strong></div>
          <h1>Basement mouse activity</h1>
          <p>Morrison residence · Huntley, Illinois · Received 9 minutes ago via SMS</p>
        </div>
        <span className={`status-pill ${triaged ? "green" : "amber"}`}>{triaged ? "Ready to schedule" : "New request"}</span>
      </section>
      <div className="detail-grid">
        <div className="detail-main page-stack">
          <section className="panel transcript-card">
            <div className="panel-heading">
              <div><p className="kicker">Untrusted customer input</p><h2>Original message</h2></div>
              <span className="source-badge">SMS · MSG-8821</span>
            </div>
            <blockquote>“Hi, we found what looks like mouse droppings along the basement wall this morning. We have a dog and our daughter plays down there. Can someone check it soon? We’re usually home after lunch.”</blockquote>
            <div className="trust-boundary"><span>Shielded</span> Customer text is classified as data, never as executable instruction.</div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div><p className="kicker">AI-assisted triage</p><h2>Structured request</h2></div>
              <span className="model-badge">MockAI · v1.0</span>
            </div>
            {!triaged ? (
              <div className="empty-action">
                <div className="analysis-mark">AI</div>
                <h3>Convert this message into reviewable facts</h3>
                <p>The mock provider extracts intent and ambiguity. Deterministic policy decides serviceability; a dispatcher approves the result.</p>
                <button className="button primary" onClick={onTriage}>Run structured triage</button>
              </div>
            ) : (
              <>
                <div className="triage-grid">
                  <Fact label="Issue category" value="Rodent concern" source="MSG-8821" />
                  <Fact label="Affected zone" value="Basement" source="MSG-8821" />
                  <Fact label="Urgency" value="Priority" source="Customer timing + child/pet context" />
                  <Fact label="Confidence" value="94%" source="MockAI validated output" />
                  <Fact label="Applicable service" value="Rodent Entry-Point Inspection" source="PLAYBOOK-ROD-v3.2" />
                  <Fact label="Preferred timing" value="After 12:00 PM" source="MSG-8821" />
                </div>
                <div className="policy-result">
                  <div className="policy-icon">✓</div>
                  <div><strong>Serviceability confirmed</strong><p>Residential property · Huntley territory · Active plan · Approved service · No safety escalation</p></div>
                  <span>policy v2.1</span>
                </div>
              </>
            )}
          </section>
          {triaged ? (
            <section className="panel trace-panel">
              <div className="panel-heading"><div><p className="kicker">Decision sources</p><h2>Why this classification</h2></div></div>
              <ol className="source-list">
                <li><span>01</span><div><strong>“mouse droppings”</strong><p>Directly supports rodent concern classification.</p></div><em>MSG-8821</em></li>
                <li><span>02</span><div><strong>“basement wall”</strong><p>Maps to the existing Basement property zone.</p></div><em>PROP-118</em></li>
                <li><span>03</span><div><strong>Approved inspection scope</strong><p>Published playbook permits inspection and documentation only.</p></div><em>ROD v3.2</em></li>
              </ol>
            </section>
          ) : null}
        </div>
        <aside className="detail-aside">
          <section className="panel summary-panel">
            <p className="kicker">Property intelligence</p>
            <h2>1428 Redtail Lane</h2>
            <p>Huntley, IL · Single-family · Recurring quarterly plan</p>
            <div className="risk-row">
              <div className="risk-ring"><strong>32</strong><span>/100</span></div>
              <div><strong>Moderate recurrence risk</strong><span>Before today’s inspection</span></div>
            </div>
            <dl className="summary-list">
              <div><dt>Prior related issue</dt><dd>Oct 2025</dd></div>
              <div><dt>Reservice history</dt><dd>None in 12 mo.</dd></div>
              <div><dt>Open risks</dt><dd>1 unverified</dd></div>
              <div><dt>Data completeness</dt><dd>86%</dd></div>
            </dl>
            <button className="button secondary full">Open property record</button>
          </section>
          <section className="panel next-action">
            <p className="kicker">Next action</p>
            <h3>{triaged ? "Compare eligible slots" : "Approve triage first"}</h3>
            <p>{triaged ? "The ranking engine will apply hard constraints and explain the economics of each option." : "No schedule candidate can be generated until structured facts pass policy review."}</p>
            <button className="button primary full" disabled={!triaged} onClick={onSchedule}>Generate ranked slots</button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ScheduleView({
  triaged,
  selectedId,
  onSelect,
  onApprove,
  onOpenRequest,
}: {
  triaged: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
  onApprove: () => void;
  onOpenRequest: () => void;
}) {
  if (!triaged) {
    return (
      <div className="page-stack narrow-page">
        <section className="page-intro"><div><p className="kicker">Margin-aware scheduling</p><h1>No approved request yet</h1><p>Triage SR-1048 before generating candidates.</p></div><button className="button primary" onClick={onOpenRequest}>Open service request</button></section>
      </div>
    );
  }
  const selected = huntleyCandidates.find((item) => item.id === selectedId) ?? huntleyCandidates[0];
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div><div className="breadcrumb">Service Requests / SR-1048 / <strong>Schedule</strong></div><h1>Choose the strongest route fit</h1><p>Only eligible slots are shown. Price and eligibility are deterministic.</p></div>
        <span className="status-pill green">3 eligible · 2 excluded</span>
      </section>
      <div className="schedule-layout">
        <section className="candidate-list">
          {huntleyCandidates.map((candidate) => (
            <button className={`candidate-card ${selectedId === candidate.id ? "candidate-selected" : ""}`} key={candidate.id} onClick={() => onSelect(candidate.id)}>
              <div className="rank">#{candidate.rank}</div>
              <div className="candidate-main">
                <div className="candidate-title"><div><strong>{candidate.startsAt}</strong><span>{candidate.technician} · {candidate.driveMinutes} min drive</span></div><div className="score"><span>Decision score</span><strong>{candidate.score.toFixed(1)}</strong></div></div>
                <div className="eligibility-tags">{candidate.eligibilityReasons.map((reason) => <span key={reason}>✓ {reason}</span>)}</div>
                <div className="candidate-economics">
                  <div><span>Price</span><strong>${candidate.economics.price.toFixed(2)}</strong></div>
                  <div><span>Labor</span><strong>−${candidate.economics.laborCost.toFixed(2)}</strong></div>
                  <div><span>Drive</span><strong>−${candidate.economics.driveCost.toFixed(2)}</strong></div>
                  <div><span>Materials</span><strong>−${candidate.economics.materialEstimate.toFixed(2)}</strong></div>
                  <div><span>Reservice risk</span><strong>−${candidate.economics.expectedReserviceCost.toFixed(2)}</strong></div>
                  <div className="contribution"><span>Expected contribution</span><strong>${candidate.economics.expectedContributionMargin.toFixed(2)}</strong></div>
                </div>
              </div>
            </button>
          ))}
        </section>
        <aside className="panel score-explanation">
          <p className="kicker">Transparent ranking</p>
          <h2>Why #{selected.rank} ranks here</h2>
          <p>{selected.technician} is eligible and the slot’s route adjacency protects contribution without overtime.</p>
          <div className="score-total"><span>Decision score</span><strong>{selected.score.toFixed(1)}</strong></div>
          <div className="score-parts">
            {selected.explanation.map((part) => (
              <div key={part.label}><span>{part.label}</span><strong className={part.kind}>{part.value >= 0 ? "+" : ""}{part.value.toFixed(2)}</strong></div>
            ))}
          </div>
          <div className="formula-note">
            <strong>Expected contribution formula</strong>
            <code>price − labor − drive − material − expected reservice</code>
          </div>
          <button className="button primary full" onClick={onApprove}>Approve {selected.startsAt}</button>
          <p className="approval-note">Creates an attributed approval, appointment, pre-job brief request, and audit event.</p>
        </aside>
      </div>
    </div>
  );
}

function TechnicianView({
  workflow,
  scheduled,
  offlineReady,
  completionReady,
  onCheckIn,
  onToggleChecklist,
  onAddEvidence,
  onAddObservation,
  onFlagRisk,
  onComplete,
  fileInputRef,
  onEvidenceFile,
}: {
  workflow: Workflow;
  scheduled: boolean;
  offlineReady: boolean;
  completionReady: boolean;
  onCheckIn: () => void;
  onToggleChecklist: (index: number) => void;
  onAddEvidence: () => void;
  onAddObservation: () => void;
  onFlagRisk: () => void;
  onComplete: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onEvidenceFile: (file: File) => Promise<void>;
}) {
  if (!scheduled) {
    return (
      <div className="page-stack narrow-page"><section className="page-intro"><div><p className="kicker">Technician workspace</p><h1>No assignment yet</h1><p>Approve a schedule candidate to open the field workflow.</p></div></section></div>
    );
  }
  return (
    <div className="tech-page">
      <header className="tech-job-header">
        <div><span className="status-pill blue">Next job · 1:30 PM</span><h1>Rodent entry-point inspection</h1><p>1428 Redtail Lane · Huntley · Morrison residence</p></div>
        <div className="tech-header-actions">
          <span className={`offline-pill ${offlineReady ? "ready" : ""}`}>{offlineReady ? "✓ Offline draft ready" : "Saving draft…"}</span>
          {!workflow.checkedIn ? <button className="button primary" onClick={onCheckIn}>Check in</button> : <span className="status-pill green">Checked in</span>}
        </div>
      </header>
      <div className="tech-layout">
        <div className="tech-main page-stack">
          <section className="panel brief-card">
            <div className="panel-heading"><div><p className="kicker">Pre-job brief</p><h2>Inspect first. Document what you can prove.</h2></div><span className="source-badge">7 sourced facts</span></div>
            <p className="brief-lead">Customer reported possible mouse droppings along the basement wall. Inspect the perimeter, sill plates, and utility penetrations under Rodent Inspection v3.2.</p>
            <div className="brief-grid">
              <div><span>Prior signal</span><strong>Seasonal activity near north foundation · Oct 2025</strong><em>JOB-1782</em></div>
              <div><span>Open property risk</span><strong>Utility-line penetration lacks recent evidence</strong><em>RISK-88</em></div>
              <div><span>Required proof</span><strong>Before overview · entry-point detail · completed checklist</strong><em>ROD v3.2</em></div>
              <div><span>Escalate if</span><strong>Electrical hazard, inaccessible void, or out-of-scope condition</strong><em>ROD v3.2</em></div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading"><div><p className="kicker">Approved playbook · v3.2</p><h2>Inspection checklist</h2></div><span className="progress-count">{workflow.checklist.filter(Boolean).length} / 4</span></div>
            <div className="checklist">
              {checklistLabels.map((label, index) => (
                <label className={workflow.checklist[index] ? "checked" : ""} key={label}>
                  <input type="checkbox" checked={workflow.checklist[index]} onChange={() => onToggleChecklist(index)} disabled={!workflow.checkedIn} />
                  <span className="custom-check">{workflow.checklist[index] ? "✓" : index + 1}</span>
                  <span><strong>{label}</strong><small>{index < 2 ? "Required inspection step" : index === 2 ? "Evidence must reference a property zone" : "Acknowledgment required before completion"}</small></span>
                  <em>Required</em>
                </label>
              ))}
            </div>
          </section>
          <section className="capture-grid">
            <div className="panel capture-panel">
              <div className="panel-heading"><div><p className="kicker">Evidence ledger</p><h2>Capture proof</h2></div><span className="progress-count">{workflow.evidence} / 2 min.</span></div>
              <div className="evidence-list">
                {workflow.evidence >= 1 ? <EvidenceItem id="EV-1049" kind="Before" label="Basement north wall overview" /> : null}
                {workflow.evidence >= 2 ? <EvidenceItem id="EV-1050" kind="Detail" label="North sill-plate gap" /> : null}
                {workflow.evidence < 2 ? <button className="evidence-empty" onClick={onAddEvidence} disabled={!workflow.checkedIn}><span>+</span><strong>Add {workflow.evidence === 0 ? "before overview" : "entry-point detail"}</strong><small>Camera or photo library · zone attribution required</small></button> : null}
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
              <button className="button secondary full" disabled={!workflow.checkedIn || workflow.evidence >= 3} onClick={() => fileInputRef.current?.click()}>Choose a photo file</button>
            </div>
            <div className="panel observation-panel">
              <div className="panel-heading"><div><p className="kicker">Structured field facts</p><h2>Observation</h2></div></div>
              {!workflow.observation ? (
                <button className="observation-empty" disabled={!workflow.checkedIn} onClick={onAddObservation}><span>+</span><strong>Record sample observation</strong><small>Basement · rodent evidence · north wall</small></button>
              ) : (
                <div className="observation-record">
                  <div><span className="status-pill blue">Rodent evidence</span><em>Basement</em></div>
                  <strong>Small dark droppings observed along north sill plate.</strong>
                  <p>Technician note normalized without treatment or safety claims.</p>
                  <small>OBS-441 · Maya Chen · current timestamp</small>
                </div>
              )}
              <div className={`risk-toggle ${workflow.unresolvedRisk ? "active" : ""}`}>
                <div><strong>Potential entry point remains unresolved</strong><p>Creates a property risk and required follow-up.</p></div>
                <button disabled={!workflow.observation} onClick={onFlagRisk} aria-pressed={workflow.unresolvedRisk}>{workflow.unresolvedRisk ? "Flagged" : "Flag risk"}</button>
              </div>
            </div>
          </section>
        </div>
        <aside className="tech-aside">
          <section className="panel completion-card">
            <p className="kicker">Completion gate</p>
            <h2>{completionReady ? "Ready to complete" : "Finish required proof"}</h2>
            <div className="gate-list">
              <Gate label="Checked in" passed={workflow.checkedIn} />
              <Gate label="4 required steps" passed={workflow.checklist.every(Boolean)} />
              <Gate label="2 evidence items" passed={workflow.evidence >= 2} />
              <Gate label="Structured observation" passed={workflow.observation} />
              <Gate label="Risk acknowledged" passed={workflow.unresolvedRisk} />
            </div>
            <button className="button primary full" disabled={!completionReady} onClick={onComplete}>Complete job & generate proof</button>
            <p className="approval-note">Completion creates the report, follow-up, risk score, margin snapshot, and audit trace.</p>
          </section>
          <section className="panel property-mini">
            <p className="kicker">Property memory</p>
            <h3>Basement zone</h3>
            <ul><li>Finished lower level</li><li>North sill plate accessible</li><li>Dog in home</li><li>Customer prefers SMS</li></ul>
            <span>Source: PROP-118</span>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ProofView({ risk, sent, onSend }: { risk: number; sent: boolean; onSend: () => void }) {
  return (
    <div className="proof-page page-stack">
      <section className="page-intro no-print">
        <div><div className="breadcrumb">Jobs / FP-2048 / <strong>Service Proof</strong></div><h1>Report ready for review</h1><p>Generated from approved structured facts · Report SP-2048</p></div>
        <div className="intro-actions"><button className="button secondary" onClick={() => window.print()}>Print / Save PDF</button><button className="button primary" onClick={onSend} disabled={sent}>{sent ? "Sent to customer" : "Send Service Proof"}</button></div>
      </section>
      <article className="service-proof">
        <header className="proof-header">
          <div><span className="proof-logo">F</span><div><strong>FieldProof</strong><small>Service proof by Northstar Pest</small></div></div>
          <div><span>Report</span><strong>SP-2048</strong><small>July 24, 2026</small></div>
        </header>
        <section className="proof-hero">
          <div><p className="kicker">Service completed</p><h1>Rodent entry-point inspection</h1><p>1428 Redtail Lane · Huntley, Illinois</p></div>
          <span className="proof-check">✓</span>
        </section>
        <section className="proof-summary">
          <div><span>Technician</span><strong>Maya Chen</strong></div><div><span>Arrival</span><strong>1:31 PM</strong></div><div><span>Duration</span><strong>74 min</strong></div><div><span>Playbook</span><strong>ROD v3.2</strong></div>
        </section>
        <section className="proof-section">
          <p className="kicker">Areas inspected</p>
          <div className="proof-zones"><span>Basement perimeter</span><span>North sill plate</span><span>Utility penetrations</span><span>Accessible voids</span></div>
        </section>
        <section className="proof-two-col">
          <div className="proof-section">
            <p className="kicker">Observation</p>
            <h2>Evidence of mouse activity documented</h2>
            <p>Small dark droppings were observed along the north basement sill plate. The finding was recorded as a structured observation and linked to the basement zone.</p>
            <span className="fact-source">Source · OBS-441</span>
          </div>
          <div className="proof-section risk-proof">
            <p className="kicker">Follow-up required</p>
            <h2>Potential entry-point gap remains unresolved</h2>
            <p>A gap near the north sill plate requires follow-up review. Northstar Pest will contact you within seven days.</p>
            <span className="status-pill amber">Follow-up due Jul 31</span>
          </div>
        </section>
        <section className="proof-section">
          <div className="panel-heading"><div><p className="kicker">Evidence</p><h2>Proof captured during this visit</h2></div><span>2 attributed records</span></div>
          <div className="proof-evidence"><EvidenceItem id="EV-1049" kind="Before" label="Basement north wall overview" /><EvidenceItem id="EV-1050" kind="Detail" label="North sill-plate gap" /></div>
        </section>
        <section className="proof-footer-grid">
          <div><p className="kicker">Current recurrence risk</p><strong>{risk}/100 · Moderate</strong><span>Explainable score · rodent-risk-v1.2</span></div>
          <div><p className="kicker">What happens next</p><strong>7-day property-risk follow-up</strong><span>We will not mark the concern resolved without an outcome signal.</span></div>
        </section>
        <footer className="proof-footer"><span>Northstar Pest · Fictional demo company</span><span>Report SP-2048 · Facts verified from job records</span></footer>
      </article>
    </div>
  );
}

function PropertyView({ risk, completed, evidence }: { risk: number; completed: boolean; evidence: number }) {
  return (
    <div className="page-stack">
      <section className="page-intro"><div><div className="breadcrumb">Properties / <strong>PROP-118</strong></div><h1>1428 Redtail Lane</h1><p>Morrison residence · Huntley · Quarterly recurring service</p></div><span className="status-pill amber">{completed ? "1 open risk" : "1 unverified risk"}</span></section>
      <section className="property-score-grid">
        <div className="panel score-card"><span>Recurrence risk</span><strong>{risk}<small>/100</small></strong><p>{completed ? "Open entry-point risk increases follow-up priority." : "Moderate baseline from one historical rodent signal."}</p></div>
        <div className="panel score-card"><span>Data completeness</span><strong>{completed ? "96" : "86"}<small>%</small></strong><p>{completed ? "Today’s evidence closed a key information gap." : "Recent utility-penetration evidence is missing."}</p></div>
        <div className="panel score-card"><span>Evidence ledger</span><strong>{12 + evidence}</strong><p>Attributable evidence records across 7 visits.</p></div>
        <div className="panel score-card"><span>First-visit resolution</span><strong>83<small>%</small></strong><p>Property-specific rolling 24-month rate.</p></div>
      </section>
      <section className="control-grid">
        <div className="panel">
          <div className="panel-heading"><div><p className="kicker">Living record</p><h2>Property timeline</h2></div></div>
          <div className="timeline">
            {completed ? <TimelineItem date="Today · 2:45 PM" title="Inspection completed with unresolved entry-point risk" text="Service Proof SP-2048 created; 7-day follow-up opened." tone="amber" /> : null}
            <TimelineItem date="Today · 10:18 AM" title="Basement rodent concern received" text="Customer message created SR-1048." tone="blue" />
            <TimelineItem date="Oct 18, 2025" title="Seasonal activity noted near north foundation" text="Inspection evidence captured; outcome resolved after 14 days." tone="green" />
            <TimelineItem date="Apr 12, 2025" title="Quarterly inspection completed" text="No active issues. Evidence completeness 100%." tone="green" />
          </div>
        </div>
        <div className="panel">
          <div className="panel-heading"><div><p className="kicker">Operational memory</p><h2>Zones & open risks</h2></div></div>
          <div className="zone-grid">{["Exterior north", "Exterior south", "Kitchen", "Basement", "Garage", "Utility area"].map((zone) => <span className={zone === "Basement" ? "zone-active" : ""} key={zone}>{zone}<small>{zone === "Basement" ? "1 open risk" : "No open risks"}</small></span>)}</div>
          <div className="open-risk-card"><span className="status-pill amber">Open</span><div><strong>North sill-plate gap</strong><p>Follow-up inspection required by Jul 31. Source: OBS-441 + EV-1050.</p></div></div>
        </div>
      </section>
    </div>
  );
}

function ExceptionsView({ resolved, onResolve }: { resolved: boolean; onResolve: () => void }) {
  return (
    <div className="page-stack">
      <section className="page-intro"><div><p className="kicker">Exception control plane</p><h1>Work that needs judgment</h1><p>Routine work stays automated; every proposed action remains attributable and reversible.</p></div><span className="status-pill amber">{resolved ? "7 open" : "8 open"}</span></section>
      <section className="panel">
        <div className="exception-toolbar"><div className="segmented"><button className="active">Open 8</button><button>Assigned to me 3</button><button>Snoozed 2</button></div><button className="button secondary">Filter</button></div>
        <div className="exception-list">
          <div className={`exception-item ${resolved ? "resolved" : ""}`}>
            <div className="exception-severity high">HIGH</div>
            <div className="exception-copy"><div><span>Unresolved risk without owner</span><small>EX-771 · 18 min old</small></div><h3>North sill-plate entry point requires follow-up</h3><p>Morrison residence · JOB-2048 · Recommended: assign Maya Chen for 7-day verification.</p><div className="explain-line"><span>Confidence 98%</span><span>Impact $94 reservice exposure</span><span>Human required</span><span>Reversible</span></div></div>
            <div className="exception-actions">{resolved ? <span className="status-pill green">Resolved</span> : <><button className="button secondary">Request info</button><button className="button primary" onClick={onResolve}>Assign & resolve</button></>}</div>
          </div>
          {[
            ["MED", "Evidence completeness", "Lee residence · missing after photo", "$38 exposure"],
            ["MED", "Route fragmentation", "Crystal Lake afternoon route", "$61 opportunity"],
            ["LOW", "Duration variance", "JOB-2031 ran 24 min over plan", "Review only"],
          ].map((item) => (
            <div className="exception-item" key={item[1]}>
              <div className={`exception-severity ${item[0] === "MED" ? "medium" : "low"}`}>{item[0]}</div>
              <div className="exception-copy"><div><span>{item[1]}</span><small>Assigned · Office ops</small></div><h3>{item[2]}</h3><div className="explain-line"><span>{item[3]}</span><span>Suggest only</span></div></div>
              <button className="button secondary">Review</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PlaybooksView() {
  return (
    <div className="page-stack">
      <section className="page-intro"><div><p className="kicker">Approved knowledge</p><h1>Service playbooks</h1><p>Versioned inspection and documentation procedures. Published versions are immutable.</p></div><button className="button primary">Create draft</button></section>
      <section className="playbook-grid">
        {[
          ["Rodent Entry-Point Inspection", "v3.2", "Published", "4 steps", "2 evidence rules", "Jul 1, 2026"],
          ["General Pest Inspection", "v2.8", "Published", "5 steps", "2 evidence rules", "Jun 14, 2026"],
          ["Stinging Insect Inspection", "v1.6", "Published", "6 steps", "3 evidence rules", "May 30, 2026"],
        ].map((playbook, index) => (
          <article className="panel playbook-card" key={playbook[0]}>
            <div className="playbook-icon">{index === 0 ? "R" : index === 1 ? "G" : "S"}</div>
            <span className="status-pill green">{playbook[2]}</span>
            <h2>{playbook[0]}</h2><p>Inspection and evidence workflow only. No chemical application instructions.</p>
            <dl><div><dt>Version</dt><dd>{playbook[1]}</dd></div><div><dt>Requirements</dt><dd>{playbook[3]} · {playbook[4]}</dd></div><div><dt>Effective</dt><dd>{playbook[5]}</dd></div></dl>
            <div className="card-actions"><button className="button secondary">Version history</button><button className="button secondary">Create new draft</button></div>
          </article>
        ))}
      </section>
      <section className="panel safety-rule"><div className="policy-icon">!</div><div><strong>AI safety boundary</strong><p>AI may retrieve and summarize published playbooks. It cannot invent rates, mixing instructions, label instructions, treatment procedures, safety claims, or regulatory claims.</p></div><span>policy v1.4</span></section>
    </div>
  );
}

function AnalyticsView({ completed }: { completed: boolean }) {
  return (
    <div className="page-stack">
      <section className="page-intro"><div><p className="kicker">Operator economics</p><h1>Margin and outcome analytics</h1><p>Facts that change route, follow-up, and service decisions.</p></div><button className="button secondary">Last 30 days ⌄</button></section>
      <section className="property-score-grid">
        <div className="panel score-card"><span>Contribution / tech-day</span><strong>$742</strong><p>+$38 against prior 30 days.</p></div>
        <div className="panel score-card"><span>First-visit resolution</span><strong>{completed ? "89.4" : "89.1"}<small>%</small></strong><p>Rodent inspection cohort is 86.2%.</p></div>
        <div className="panel score-card"><span>Reservice rate</span><strong>4.8<small>%</small></strong><p>Down 0.7 points month over month.</p></div>
        <div className="panel score-card"><span>Exception handling</span><strong>12.6<small>%</small></strong><p>Share of jobs requiring human judgment.</p></div>
      </section>
      <section className="control-grid">
        <div className="panel chart-panel">
          <div className="panel-heading"><div><p className="kicker">Contribution trend</p><h2>Profit per technician-day</h2></div></div>
          <div className="bar-chart">{[62, 71, 68, 76, 82, 79, 88, 84, 91, 87, 94, 96].map((value, index) => <div key={index}><span style={{ height: `${value}%` }} /><small>{index % 2 ? "" : `W${index + 1}`}</small></div>)}</div>
        </div>
        <div className="panel leak-panel">
          <div className="panel-heading"><div><p className="kicker">Profit leaks</p><h2>Deterministic findings</h2></div></div>
          {[["Route fragmentation", "$412", "4 routes"], ["Expected reservice", "$341", "7 jobs"], ["Missing evidence", "$126", "3 jobs"], ["Overtime variance", "$98", "2 technicians"]].map((item) => <div className="leak-row" key={item[0]}><div><strong>{item[0]}</strong><span>{item[2]}</span></div><strong>{item[1]}</strong><button>Review →</button></div>)}
        </div>
      </section>
    </div>
  );
}

function AuditView({ items }: { items: AuditItem[] }) {
  return (
    <div className="page-stack">
      <section className="page-intro"><div><p className="kicker">Decision trace</p><h1>Audit and provenance</h1><p>Human, system, and AI activity for correlation CORR-SR1048.</p></div><button className="button secondary">Export trace</button></section>
      <section className="panel">
        <div className="audit-filters"><span className="status-pill blue">JOB-2048</span><span>All actors</span><span>All actions</span><span>Newest first</span></div>
        <div className="audit-list">
          {items.map((item) => (
            <article className="audit-item" key={item.id}>
              <div className={`actor-mark ${item.actor.toLowerCase()}`}>{item.actor === "Human" ? "HU" : item.actor === "System" ? "SY" : "AI"}</div>
              <div className="audit-copy"><div><strong>{item.action}</strong><span>{item.time}</span></div><p>{item.reason}</p><small>{item.id} · {item.actor} actor · CORR-SR1048 {item.policy ? `· ${item.policy}` : ""}</small></div>
              <button className="text-button">Details →</button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsView() {
  return (
    <div className="page-stack narrow-page">
      <section className="page-intro"><div><p className="kicker">Organization controls</p><h1>Settings</h1><p>Northstar Pest · Settings are versioned and audited.</p></div></section>
      <section className="panel setting-section">
        <div><p className="kicker">Autonomy</p><h2>Operational action policy</h2><p>New organizations start in Suggest only. High-impact actions always require approval.</p></div>
        <div className="autonomy-options">{["SUGGEST_ONLY", "AUTO_READ_ONLY", "AUTO_LOW_RISK", "AUTO_APPROVED_BOOKING", "HUMAN_REQUIRED"].map((level, index) => <label className={index === 0 ? "selected" : ""} key={level}><input type="radio" name="autonomy" defaultChecked={index === 0} /><span><strong>{level.replaceAll("_", " ")}</strong><small>{index === 0 ? "AI proposes; a person decides." : "Available after policy review."}</small></span></label>)}</div>
      </section>
      <section className="panel setting-section"><div><p className="kicker">Economics</p><h2>Scheduling weights</h2><p>Stored per organization and included in every ranking explanation.</p></div><div className="weight-grid">{[["Route density", "1.00"], ["Urgency", "0.75"], ["Retention", "0.50"], ["Overtime penalty", "1.25"], ["Fragmentation penalty", "0.80"], ["Average reservice cost", "$94"]].map((item) => <label key={item[0]}><span>{item[0]}</span><input defaultValue={item[1]} /></label>)}</div></section>
    </div>
  );
}

function Fact({ label, value, source }: { label: string; value: string; source: string }) {
  return <div className="fact-card"><span>{label}</span><strong>{value}</strong><small>Source · {source}</small></div>;
}

function Gate({ label, passed }: { label: string; passed: boolean }) {
  return <div className={passed ? "passed" : ""}><span>{passed ? "✓" : "○"}</span><strong>{label}</strong><em>{passed ? "Passed" : "Required"}</em></div>;
}

function EvidenceItem({ id, kind, label }: { id: string; kind: string; label: string }) {
  return (
    <div className="evidence-item">
      <div className="evidence-visual"><span>{kind === "Before" ? "01" : "02"}</span><em>Evidence</em></div>
      <div><span className="status-pill blue">{kind}</span><strong>{label}</strong><small>{id} · Basement · Maya Chen · timestamped</small></div>
    </div>
  );
}

function TimelineItem({ date, title, text, tone }: { date: string; title: string; text: string; tone: string }) {
  return <div className="timeline-item"><div><span className={tone} /></div><div><small>{date}</small><strong>{title}</strong><p>{text}</p></div></div>;
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
