import { z } from "zod";

export const AutonomyLevelSchema = z.enum([
  "SUGGEST_ONLY",
  "AUTO_READ_ONLY",
  "AUTO_LOW_RISK",
  "AUTO_APPROVED_BOOKING",
  "HUMAN_REQUIRED",
]);

export const TriageResultSchema = z.object({
  issueCategory: z.enum(["RODENT", "GENERAL_PEST", "STINGING_INSECT", "UNSUPPORTED"]),
  serviceType: z.string(),
  affectedZones: z.array(z.string()),
  urgency: z.enum(["ROUTINE", "PRIORITY", "URGENT"]),
  safetyFlags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  serviceable: z.boolean(),
  ambiguity: z.array(z.string()),
  sourceFacts: z.array(z.string()),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

export type MarginInputs = {
  price: number;
  laborMinutes: number;
  laborCostPerHour: number;
  driveMinutes: number;
  driveCostPerMinute: number;
  materialEstimate: number;
  reserviceProbability: number;
  averageReserviceCost: number;
};

export type MarginBreakdown = MarginInputs & {
  laborCost: number;
  driveCost: number;
  expectedReserviceCost: number;
  expectedContributionMargin: number;
};

export function calculateMargin(input: MarginInputs): MarginBreakdown {
  const laborCost = round((input.laborMinutes / 60) * input.laborCostPerHour);
  const driveCost = round(input.driveMinutes * input.driveCostPerMinute);
  const expectedReserviceCost = round(input.reserviceProbability * input.averageReserviceCost);
  return {
    ...input,
    laborCost,
    driveCost,
    expectedReserviceCost,
    expectedContributionMargin: round(
      input.price - laborCost - driveCost - input.materialEstimate - expectedReserviceCost,
    ),
  };
}

export type CandidateInput = {
  id: string;
  technician: string;
  technicianId: string;
  startsAt: string;
  eligible: boolean;
  eligibilityReasons: string[];
  margin: MarginInputs;
  routeDensityBonus: number;
  urgencyBonus: number;
  retentionValue: number;
  overtimePenalty: number;
  latenessPenalty: number;
  fragmentationPenalty: number;
  driveMinutes: number;
};

export type RankedCandidate = CandidateInput & {
  rank: number;
  score: number;
  economics: MarginBreakdown;
  explanation: { label: string; value: number; kind: "positive" | "negative" | "neutral" }[];
};

export function rankScheduleCandidates(candidates: CandidateInput[]): RankedCandidate[] {
  return candidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => {
      const economics = calculateMargin(candidate.margin);
      const explanation: RankedCandidate["explanation"] = [
        { label: "Expected contribution", value: economics.expectedContributionMargin, kind: "neutral" },
        { label: "Route density", value: candidate.routeDensityBonus, kind: "positive" },
        { label: "Urgency", value: candidate.urgencyBonus, kind: "positive" },
        { label: "Retention value", value: candidate.retentionValue, kind: "positive" },
        { label: "Overtime", value: -candidate.overtimePenalty, kind: "negative" },
        { label: "Lateness", value: -candidate.latenessPenalty, kind: "negative" },
        { label: "Fragmentation", value: -candidate.fragmentationPenalty, kind: "negative" },
      ];
      return {
        ...candidate,
        rank: 0,
        economics,
        explanation,
        score: round(explanation.reduce((total, part) => total + part.value, 0)),
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export const RiskInputsSchema = z.object({
  relatedIssues: z.number().int().nonnegative(),
  reserviceEvents90Days: z.number().int().nonnegative(),
  openRisks: z.number().int().nonnegative(),
  missingEvidence: z.boolean(),
  incompleteSteps: z.boolean(),
  priorUnresolvedOutcome: z.boolean(),
  followUpOverdue: z.boolean(),
  uncertaintyFlag: z.boolean(),
});

export type RiskInputs = z.infer<typeof RiskInputsSchema>;

export function calculateRecurrenceRisk(input: RiskInputs) {
  const parsed = RiskInputsSchema.parse(input);
  const contributions = [
    { key: "baseline", label: "Rodent recurrence baseline", points: 25 },
    { key: "relatedIssues", label: "Prior related issues", points: Math.min(parsed.relatedIssues * 7, 21) },
    { key: "reservice", label: "Recent reservice events", points: Math.min(parsed.reserviceEvents90Days * 12, 24) },
    { key: "openRisks", label: "Confirmed open property risks", points: Math.min(parsed.openRisks * 15, 30) },
    { key: "priorUnresolved", label: "Prior unresolved outcome", points: parsed.priorUnresolvedOutcome ? 12 : 0 },
    { key: "followUp", label: "Follow-up overdue", points: parsed.followUpOverdue ? 9 : 0 },
  ];
  const rawScore = contributions.reduce((total, item) => total + item.points, 0);
  const gaps = [
    {
      key: "missingEvidence",
      label: "Required evidence has not been captured",
      penalty: parsed.missingEvidence ? 30 : 0,
    },
    {
      key: "incompleteSteps",
      label: "Required playbook steps are incomplete",
      penalty: parsed.incompleteSteps ? 30 : 0,
    },
    {
      key: "uncertainty",
      label: "Technician marked the assessment uncertain",
      penalty: parsed.uncertaintyFlag ? 20 : 0,
    },
  ].filter((item) => item.penalty > 0);
  const completenessScore = Math.max(
    0,
    100 - gaps.reduce((total, item) => total + item.penalty, 0),
  );

  return {
    score: Math.min(100, rawScore),
    rawScore,
    version: "rodent-risk-v2.0",
    contributions: contributions.filter((item) => item.points > 0),
    dataCompleteness: {
      score: completenessScore,
      status:
        completenessScore === 100
          ? ("COMPLETE" as const)
          : completenessScore >= 70
            ? ("PARTIAL" as const)
            : ("LIMITED" as const),
      gaps,
    },
  };
}

export function calculatePropertyCompleteness(fields: Record<string, boolean>) {
  const weights: Record<string, number> = {
    propertyType: 15,
    serviceZones: 15,
    accessInstructions: 10,
    historicalObservations: 20,
    evidence: 20,
    openRiskStatus: 10,
    recurringPlan: 10,
  };
  const missing = Object.keys(weights).filter((key) => !fields[key]);
  return {
    score: Object.entries(weights).reduce((total, [key, weight]) => total + (fields[key] ? weight : 0), 0),
    missing,
  };
}

const actionPolicies = {
  TRIAGE_REQUEST: { effect: "READ_ONLY" },
  PROPOSE_APPOINTMENT: { effect: "READ_ONLY" },
  APPROVE_APPOINTMENT: { effect: "WRITE" },
  CREATE_FOLLOW_UP: { effect: "WRITE" },
  GENERATE_REPORT: { effect: "WRITE" },
} as const;

export const ActionApprovalSchema = z.object({
  id: z.string().min(1),
  actionType: z.string().min(1),
  actorId: z.string().min(1),
  tenantMatch: z.boolean(),
  grantedAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type ActionApproval = z.infer<typeof ActionApprovalSchema>;

export function evaluateActionPolicy(input: {
  actionType: string;
  autonomyLevel: z.infer<typeof AutonomyLevelSchema>;
  confidence: number;
  expiresAt: string;
  tenantMatch: boolean;
  approval?: ActionApproval;
  evaluatedAt?: string;
}) {
  const action = actionPolicies[input.actionType as keyof typeof actionPolicies];
  if (!action) {
    return policyDenial("UNKNOWN_ACTION", "Unknown action type rejected.", false);
  }
  if (!AutonomyLevelSchema.safeParse(input.autonomyLevel).success) {
    return policyDenial("INVALID_AUTONOMY", "Unknown autonomy level rejected.", false, action.effect);
  }
  if (!input.tenantMatch) {
    return policyDenial("TENANT_MISMATCH", "Tenant scope mismatch.", false, action.effect);
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    return policyDenial("INVALID_CONFIDENCE", "Confidence must be between 0 and 1.", false, action.effect);
  }

  const evaluatedAt = input.evaluatedAt ? new Date(input.evaluatedAt).getTime() : Date.now();
  const expiresAt = new Date(input.expiresAt).getTime();
  if (!Number.isFinite(evaluatedAt) || !Number.isFinite(expiresAt)) {
    return policyDenial("INVALID_TIME", "Policy timestamps are invalid.", false, action.effect);
  }
  if (expiresAt <= evaluatedAt) {
    return policyDenial("EXPIRED", "Proposal expired.", false, action.effect);
  }
  if (input.confidence < 0.65) {
    return policyDenial(
      "LOW_CONFIDENCE",
      "Confidence below policy threshold.",
      false,
      action.effect,
    );
  }

  const approvalRequired =
    action.effect === "WRITE" || input.autonomyLevel === "HUMAN_REQUIRED";
  if (approvalRequired) {
    const approval = ActionApprovalSchema.safeParse(input.approval);
    if (!approval.success) {
      return policyDenial(
        "APPROVAL_REQUIRED",
        "A valid human approval is required before this action can execute.",
        true,
        action.effect,
      );
    }
    const approvalGrantedAt = new Date(approval.data.grantedAt).getTime();
    const approvalExpiresAt = new Date(approval.data.expiresAt).getTime();
    const approvalMatches =
      approval.data.actionType === input.actionType &&
      approval.data.tenantMatch &&
      Number.isFinite(approvalGrantedAt) &&
      Number.isFinite(approvalExpiresAt) &&
      approvalGrantedAt <= evaluatedAt &&
      approvalExpiresAt > evaluatedAt;
    if (!approvalMatches) {
      return policyDenial(
        "INVALID_APPROVAL",
        "Human approval is invalid, expired, or outside the action scope.",
        true,
        action.effect,
      );
    }
  }

  return {
    allowed: true,
    requiresApproval: false,
    approvalRequired,
    reason: "Policy fieldproof-ops-v2.0 satisfied.",
    code: "ALLOWED" as const,
    effect: action.effect,
    policyVersion: "fieldproof-ops-v2.0",
  };
}

function policyDenial(
  code: string,
  reason: string,
  requiresApproval: boolean,
  effect?: "READ_ONLY" | "WRITE",
) {
  return {
    allowed: false,
    requiresApproval,
    approvalRequired: requiresApproval,
    reason,
    code,
    effect,
    policyVersion: "fieldproof-ops-v2.0",
  };
}

export const huntleyCandidates = rankScheduleCandidates([
  {
    id: "SC-2401",
    technician: "Maya Chen",
    technicianId: "TECH-04",
    startsAt: "Today · 1:30 PM",
    eligible: true,
    eligibilityReasons: ["Rodent inspection skill", "Huntley territory", "90-minute capacity"],
    margin: { price: 189, laborMinutes: 75, laborCostPerHour: 31, driveMinutes: 11, driveCostPerMinute: 0.72, materialEstimate: 8, reserviceProbability: 0.12, averageReserviceCost: 94 },
    routeDensityBonus: 18,
    urgencyBonus: 10,
    retentionValue: 7,
    overtimePenalty: 0,
    latenessPenalty: 0,
    fragmentationPenalty: 3,
    driveMinutes: 11,
  },
  {
    id: "SC-2402",
    technician: "Andre Silva",
    technicianId: "TECH-07",
    startsAt: "Today · 3:45 PM",
    eligible: true,
    eligibilityReasons: ["Rodent inspection skill", "Huntley territory", "90-minute capacity"],
    margin: { price: 189, laborMinutes: 75, laborCostPerHour: 29, driveMinutes: 24, driveCostPerMinute: 0.72, materialEstimate: 8, reserviceProbability: 0.16, averageReserviceCost: 94 },
    routeDensityBonus: 6,
    urgencyBonus: 10,
    retentionValue: 7,
    overtimePenalty: 0,
    latenessPenalty: 4,
    fragmentationPenalty: 8,
    driveMinutes: 24,
  },
  {
    id: "SC-2403",
    technician: "Eli Brooks",
    technicianId: "TECH-02",
    startsAt: "Tomorrow · 8:00 AM",
    eligible: true,
    eligibilityReasons: ["Rodent inspection skill", "Huntley territory", "90-minute capacity"],
    margin: { price: 189, laborMinutes: 75, laborCostPerHour: 34, driveMinutes: 8, driveCostPerMinute: 0.72, materialEstimate: 8, reserviceProbability: 0.1, averageReserviceCost: 94 },
    routeDensityBonus: 14,
    urgencyBonus: 4,
    retentionValue: 7,
    overtimePenalty: 0,
    latenessPenalty: 0,
    fragmentationPenalty: 1,
    driveMinutes: 8,
  },
]);

function round(value: number) {
  return Math.round(value * 100) / 100;
}
