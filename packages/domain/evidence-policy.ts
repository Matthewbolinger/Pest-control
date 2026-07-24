import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(128);

export const EvidencePhaseSchema = z.enum(["BEFORE", "DURING", "AFTER"]);
export type EvidencePhase = z.infer<typeof EvidencePhaseSchema>;

export const EvidenceSubjectSchema = z.enum([
  "AREA_OVERVIEW",
  "PEST_EVIDENCE",
  "ENTRY_POINT",
  "WORK_PERFORMED",
  "OTHER",
]);
export type EvidenceSubject = z.infer<typeof EvidenceSubjectSchema>;

export const TypedEvidenceSchema = z
  .object({
    id: IdentifierSchema,
    phase: EvidencePhaseSchema,
    subject: EvidenceSubjectSchema,
    zoneId: IdentifierSchema,
    capturedAt: z.string().datetime(),
  })
  .strict();

export type TypedEvidence = z.infer<typeof TypedEvidenceSchema>;

export const EvidenceRequirementSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string().trim().min(1).max(200),
    phase: EvidencePhaseSchema,
    subject: EvidenceSubjectSchema,
    zoneId: IdentifierSchema.nullable(),
    minimumCount: z.number().int().min(1).max(20),
  })
  .strict();

export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

export const EvidencePolicySchema = z
  .object({
    policyVersion: z.string().trim().min(1).max(64),
    requirements: z.array(EvidenceRequirementSchema).min(1).max(100),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = new Set<string>();
    const signatures = new Set<string>();
    for (const [index, requirement] of policy.requirements.entries()) {
      if (ids.has(requirement.id)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "id"],
          message: "Evidence requirement identifiers must be unique.",
        });
      }
      ids.add(requirement.id);
      const signature = [
        requirement.phase,
        requirement.subject,
        requirement.zoneId ?? "*",
      ].join(":");
      if (signatures.has(signature)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index],
          message:
            "Equivalent evidence requirements must be expressed with one minimumCount.",
        });
      }
      signatures.add(signature);
    }
  });

export type EvidencePolicy = z.infer<typeof EvidencePolicySchema>;

export const EvidenceRequirementResultSchema = z
  .object({
    requirementId: IdentifierSchema,
    label: z.string().trim().min(1).max(200),
    requiredCount: z.number().int().min(1),
    matchedCount: z.number().int().nonnegative(),
    matchedEvidenceIds: z.array(IdentifierSchema),
    satisfied: z.boolean(),
  })
  .strict();

export const EvidencePolicyResultSchema = z
  .object({
    policyVersion: z.string().trim().min(1).max(64),
    satisfied: z.boolean(),
    requirements: z.array(EvidenceRequirementResultSchema),
    missingRequirementIds: z.array(IdentifierSchema),
  })
  .strict();

export type EvidencePolicyResult = z.infer<typeof EvidencePolicyResultSchema>;

const EvidenceCollectionSchema = z
  .array(TypedEvidenceSchema)
  .max(1_000)
  .superRefine((evidence, context) => {
    const ids = new Set<string>();
    for (const [index, item] of evidence.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Evidence identifiers must be unique.",
        });
      }
      ids.add(item.id);
    }
  });

export function evidenceMatchesRequirement(
  evidenceInput: unknown,
  requirementInput: unknown,
): boolean {
  const evidence = TypedEvidenceSchema.parse(evidenceInput);
  const requirement = EvidenceRequirementSchema.parse(requirementInput);
  return (
    evidence.phase === requirement.phase &&
    evidence.subject === requirement.subject &&
    (requirement.zoneId === null || evidence.zoneId === requirement.zoneId)
  );
}

export function evaluateEvidencePolicy(
  policyInput: unknown,
  evidenceInput: unknown,
): EvidencePolicyResult {
  const policy = EvidencePolicySchema.parse(policyInput);
  const evidence = EvidenceCollectionSchema.parse(evidenceInput);

  const requirements = policy.requirements.map((requirement) => {
    const matchedEvidenceIds = evidence
      .filter((item) => evidenceMatchesRequirement(item, requirement))
      .map((item) => item.id);
    return {
      requirementId: requirement.id,
      label: requirement.label,
      requiredCount: requirement.minimumCount,
      matchedCount: matchedEvidenceIds.length,
      matchedEvidenceIds,
      satisfied: matchedEvidenceIds.length >= requirement.minimumCount,
    };
  });
  const missingRequirementIds = requirements
    .filter((requirement) => !requirement.satisfied)
    .map((requirement) => requirement.requirementId);

  return EvidencePolicyResultSchema.parse({
    policyVersion: policy.policyVersion,
    satisfied: missingRequirementIds.length === 0,
    requirements,
    missingRequirementIds,
  });
}

export function requireEvidencePolicy(
  policyInput: unknown,
  evidenceInput: unknown,
): EvidencePolicyResult {
  const result = evaluateEvidencePolicy(policyInput, evidenceInput);
  if (!result.satisfied) {
    throw new EvidencePolicyError(
      "EVIDENCE_REQUIREMENTS_NOT_MET",
      `Missing required evidence: ${result.missingRequirementIds.join(", ")}.`,
      result,
    );
  }
  return result;
}

export class EvidencePolicyError extends Error {
  constructor(
    readonly code: "EVIDENCE_REQUIREMENTS_NOT_MET",
    message: string,
    readonly result: EvidencePolicyResult,
  ) {
    super(message);
    this.name = "EvidencePolicyError";
  }
}
