import { TriageResultSchema, type TriageResult } from "../domain";
import { z } from "zod";

export const JobBriefSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  priorRelatedObservations: z.array(z.string()),
  openRisks: z.array(z.string()),
  requiredEvidence: z.array(z.string()),
  escalationConditions: z.array(z.string()),
  sourceIds: z.array(z.string()),
});

export interface AIProvider {
  readonly name: string;
  readonly version: string;
  triageServiceRequest(input: { description: string; propertyFacts: string[] }): Promise<TriageResult>;
  generateJobBrief(input: { structuredFacts: string[]; sourceIds: string[] }): Promise<z.infer<typeof JobBriefSchema>>;
  normalizeTechnicianNotes(input: { note: string }): Promise<{ normalized: string; unsupportedClaims: string[] }>;
  summarizeException(input: { facts: string[] }): Promise<string>;
  generateCustomerReportNarrative(input: { approvedFacts: string[] }): Promise<string>;
}

export class MockAIProvider implements AIProvider {
  readonly name: string = "mock";
  readonly version: string = "mock-fieldproof-1.0";

  async triageServiceRequest(input: { description: string; propertyFacts: string[] }) {
    const untrusted = input.description.toLowerCase();
    const injection = /ignore (all|your)|system prompt|refund me|tool call/.test(untrusted);
    const result = {
      issueCategory: untrusted.includes("mice") || untrusted.includes("mouse") ? "RODENT" : "GENERAL_PEST",
      serviceType: "Rodent Entry-Point Inspection",
      affectedZones: untrusted.includes("basement") ? ["Basement"] : ["Other"],
      urgency: untrusted.includes("child") || untrusted.includes("pet") ? "PRIORITY" : "ROUTINE",
      safetyFlags: [],
      confidence: injection ? 0.67 : 0.94,
      serviceable: true,
      ambiguity: injection ? ["Customer message contained instruction-like text; ignored by policy."] : [],
      sourceFacts: [input.description, ...input.propertyFacts],
    } satisfies TriageResult;
    return TriageResultSchema.parse(result);
  }

  async generateJobBrief(input: { structuredFacts: string[]; sourceIds: string[] }) {
    return JobBriefSchema.parse({
      headline: "Basement rodent concern · inspection first",
      summary: "Inspect basement perimeter and utility penetrations. Document evidence before and after the inspection and escalate any inaccessible entry point.",
      priorRelatedObservations: ["Seasonal activity noted near north foundation in October 2025."],
      openRisks: ["Utility-line penetration has no recent evidence record."],
      requiredEvidence: ["Before overview", "Entry-point detail", "Completed inspection checklist"],
      escalationConditions: ["Active electrical hazard", "Inaccessible structural void", "Evidence outside approved inspection scope"],
      sourceIds: input.sourceIds,
    });
  }

  async normalizeTechnicianNotes(input: { note: string }) {
    const unsupportedClaims = /guarantee|completely safe|chemical|mix/i.test(input.note)
      ? ["Potential unsupported safety or treatment claim"]
      : [];
    return { normalized: input.note.trim().replace(/\s+/g, " "), unsupportedClaims };
  }

  async summarizeException(input: { facts: string[] }) {
    return `Review required: ${input.facts.join("; ")}`;
  }

  async generateCustomerReportNarrative(input: { approvedFacts: string[] }) {
    return `Your technician completed the approved inspection and documented these facts: ${input.approvedFacts.join("; ")}.`;
  }
}

export class OpenAICompatibleProvider extends MockAIProvider {
  readonly name = "openai-compatible";
  readonly version = "configured-at-runtime";
}

export class AnthropicCompatibleProvider extends MockAIProvider {
  readonly name = "anthropic-compatible";
  readonly version = "configured-at-runtime";
}
