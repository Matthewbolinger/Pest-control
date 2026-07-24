# AI safety

AI functions are narrow, stateless, provider-neutral, and schema validated.

Allowed: classify intent, extract facts, summarize approved records, identify ambiguity, draft explanations, and propose typed actions.

Never allowed: change price, issue refunds, assign technicians, finalize appointments, close complaints, publish playbooks, alter treatment records, create chemical instructions, modify permissions, or execute unknown actions.

## Prompt-injection boundary

Customer messages, technician notes, imported data, image metadata, and integration payloads are untrusted. They are passed as data, never concatenated into system policy. Outputs are Zod-validated, action types are allowlisted, tenant and permission checks are repeated, deterministic policy is authoritative, and the decision is audited.

The deterministic mock now marks unsupported commercial work, out-of-territory properties, cross-organization requests, chemical guidance, unauthorized discounts/refunds, permission changes, regulatory guarantees, and prompt injection as non-serviceable or human-review cases. The evaluation suite asserts serviceability, urgency, safety flags, confidence, ambiguity, and prohibited output—not category alone.

The OpenAI-compatible and Anthropic-compatible classes are explicit unconfigured boundaries and fail closed. They do not inherit mock behavior or imply a remote provider is implemented.
