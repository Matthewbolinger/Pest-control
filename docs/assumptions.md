# FieldProof implementation assumptions

1. This delivery optimizes for the complete Huntley rodent-inspection vertical slice rather than shallow coverage of every administrative module.
2. The existing Sites/Vinext foundation is preserved. Cloudflare D1 and R2 replace PostgreSQL and MinIO in the deployable demo; domain and adapter boundaries keep a future Fastify/PostgreSQL service possible.
3. The repository uses npm because the initialized project already owns an npm lockfile. Equivalent commands are provided instead of replacing the package manager.
4. Hosted authentication uses the platform-provided authenticated identity. The pilot is single-tenant; the server derives the Northstar tenant and actor and rejects client-supplied tenant or actor fields. Full membership lifecycle and role administration remain future production work.
5. The seeded organizations, people, addresses, identifiers, prices, and evidence descriptions are fictional.
6. No chemical application, pesticide rate, mixing, safety, or regulatory instruction is included.
7. Photos in the MVP are represented by attributable evidence records and optional local upload previews. Production storage uses signed R2 operations and malware scanning.
8. The scoring models are transparent heuristics intended for operator review, not trained machine-learning models.
9. New organizations default to `SUGGEST_ONLY`; both triage advancement and appointment approval remain explicit human actions.
10. The production scope still requires full membership lifecycle management, a background outbox consumer, real remote-provider adapters, formal accessibility testing, and jurisdiction-specific legal review.
11. **Restart demo workflow** resets only the active workflow projection. It intentionally preserves audit events, normalized records, and evidence objects as retained history; it is not a destructive data-erasure control.
