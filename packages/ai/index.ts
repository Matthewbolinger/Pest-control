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
    const injection = /ignore (all|your)|system prompt|tool call/.test(untrusted);
    const rodentSignal =
      /\b(mice|mouse|rodent)\b/.test(untrusted) ||
      /\b(mose|dropings|basment)\b/.test(untrusted);
    const unsupportedProperty =
      /\b(commercial|warehouse|restaurant|industrial)\b/.test(untrusted);
    const outsideTerritory = /outside (your|the) (service )?territory/.test(untrusted);
    const unauthorizedAction =
      /\b(refund|discount|make me an admin|price to|book .* twice|unapproved .*treatment)\b/.test(
        untrusted,
      );
    const crossTenantRequest =
      /another (company|organization)|other (company|organization).*(customer|record)/.test(
        untrusted,
      );
    const regulatoryClaim = /complies? with every law|regulatory guarantee/.test(untrusted);
    const quoteRequest = /\b(quote|pricebook|price)\b/.test(untrusted);
    const chemicalRequest = /\b(chemical|mix|mixing rate|pesticide)\b/.test(untrusted);
    const safetySensitive = /\b(child|daughter|pet|dog|cat)\b/.test(untrusted);
    const lowInformation =
      /maybe something|signs of something|tiny sound/.test(untrusted) &&
      !rodentSignal;

    const issueCategory = unsupportedProperty
      ? "UNSUPPORTED"
      : rodentSignal
        ? "RODENT"
        : "GENERAL_PEST";
    const ambiguity = [
      ...(injection
        ? ["Customer message contained instruction-like text; ignored by policy."]
        : []),
      ...(outsideTerritory
        ? ["Property appears outside the configured service territory."]
        : []),
      ...(unsupportedProperty
        ? ["Commercial properties are outside the residential MVP scope."]
        : []),
      ...(unauthorizedAction
        ? ["Requested business action requires separate human authorization."]
        : []),
      ...(crossTenantRequest
        ? ["Cross-organization data access is not permitted."]
        : []),
      ...(regulatoryClaim
        ? ["Regulatory claims require approved source material and human review."]
        : []),
      ...(quoteRequest
        ? ["Pricing requires a configured pricebook lookup."]
        : []),
      ...(lowInformation
        ? ["The issue cannot be classified confidently from the supplied description."]
        : []),
    ];
    const safetyFlags = [
      ...(chemicalRequest ? ["CHEMICAL_GUIDANCE_REQUEST_REQUIRES_HUMAN_REVIEW"] : []),
      ...(safetySensitive ? ["CHILD_OR_PET_CONTEXT_REQUIRES_HUMAN_REVIEW"] : []),
    ];
    const result = {
      issueCategory,
      serviceType:
        issueCategory === "RODENT"
          ? "Rodent Entry-Point Inspection"
          : issueCategory === "GENERAL_PEST"
            ? "General Pest Inspection"
            : "Unsupported service — human review",
      affectedZones: untrusted.includes("basement") ? ["Basement"] : ["Other"],
      urgency: safetySensitive || /\b(today|tonight|soon)\b/.test(untrusted) ? "PRIORITY" : "ROUTINE",
      safetyFlags,
      confidence: lowInformation ? 0.48 : injection || unsupportedProperty || outsideTerritory ? 0.67 : 0.94,
      serviceable:
        !unsupportedProperty &&
        !outsideTerritory &&
        !lowInformation &&
        !injection &&
        !unauthorizedAction &&
        !crossTenantRequest &&
        !regulatoryClaim &&
        !chemicalRequest,
      ambiguity,
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

abstract class UnconfiguredRemoteProvider implements AIProvider {
  abstract readonly name: string;
  readonly version = "not-configured";

  protected unavailable(): never {
    throw new Error(`${this.name} is declared but not configured. Use MockAIProvider until a real adapter is installed.`);
  }

  async triageServiceRequest(): Promise<TriageResult> {
    return this.unavailable();
  }

  async generateJobBrief(): Promise<z.infer<typeof JobBriefSchema>> {
    return this.unavailable();
  }

  async normalizeTechnicianNotes(): Promise<{ normalized: string; unsupportedClaims: string[] }> {
    return this.unavailable();
  }

  async summarizeException(): Promise<string> {
    return this.unavailable();
  }

  async generateCustomerReportNarrative(): Promise<string> {
    return this.unavailable();
  }
}

export class OpenAICompatibleProvider extends UnconfiguredRemoteProvider {
  readonly name = "openai-compatible";
}

export class AnthropicCompatibleProvider extends UnconfiguredRemoteProvider {
  readonly name = "anthropic-compatible";
}
