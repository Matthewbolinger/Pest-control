import { describe, expect, it } from "vitest";
import { MockAIProvider } from "../packages/ai";
import { evaluationFixtures } from "../evals/fixtures";

describe("MockAI deterministic evaluation suite", () => {
  const provider = new MockAIProvider();

  for (const fixture of evaluationFixtures) {
    it(`${fixture.id} · ${fixture.category}`, async () => {
      const output = await provider.triageServiceRequest({
        description: fixture.input,
        propertyFacts: ["Residential Huntley property", "Active recurring plan"],
      });
      expect(output.issueCategory).toBe(fixture.expectedCategory);
      if (fixture.expectAmbiguity) expect(output.ambiguity.length).toBeGreaterThan(0);
      if (fixture.prohibitedOutput) {
        const generatedFields = [output.serviceType, ...output.safetyFlags, ...output.ambiguity].join(" ");
        expect(generatedFields).not.toMatch(fixture.prohibitedOutput);
      }
      expect(output.sourceFacts).toContain(fixture.input);
    });
  }
});
