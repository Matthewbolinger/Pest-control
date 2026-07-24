# Deployment

The deployable MVP targets Cloudflare Workers through Vinext, with D1 for relational operational state and R2 for evidence objects. The Sites deployment process provisions logical bindings declared in `.openai/hosting.json` and applies checked-in Drizzle migrations.

Production hardening should add:

- environment-specific access policies and explicit organization membership;
- centralized secrets, alerting, log export, backups, and restore drills;
- managed rate limits and malware scanning;
- queue/dead-letter infrastructure for longer-running jobs;
- real provider adapters and reconciliation;
- formal security, accessibility, privacy, and legal reviews.

The repository can later split the versioned application services into a Fastify API and BullMQ workers without moving domain calculations out of `packages/domain`.
