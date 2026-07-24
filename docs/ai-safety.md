# AI safety

AI functions are narrow, stateless, provider-neutral, and schema validated.

Allowed: classify intent, extract facts, summarize approved records, identify ambiguity, draft explanations, and propose typed actions.

Never allowed: change price, issue refunds, assign technicians, finalize appointments, close complaints, publish playbooks, alter treatment records, create chemical instructions, modify permissions, or execute unknown actions.

## Prompt-injection boundary

Customer messages, technician notes, imported data, image metadata, and integration payloads are untrusted. They are passed as data, never concatenated into system policy. Outputs are Zod-validated, action types are allowlisted, tenant and permission checks are repeated, deterministic policy is authoritative, and the decision is audited.

The evaluation suite includes instruction injection, refunds, discounts, chemical guidance, unsupported safety claims, tenant crossing, duplicate booking, permission escalation, and false-resolution cases.
