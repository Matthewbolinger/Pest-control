# FieldProof implementation assumptions

1. This delivery optimizes for the complete Huntley rodent-inspection vertical slice rather than shallow coverage of every administrative module.
2. The existing Sites/Vinext foundation is preserved. Cloudflare D1 and R2 replace PostgreSQL and MinIO in the deployable demo; domain and adapter boundaries keep a future Fastify/PostgreSQL service possible.
3. The repository uses npm because the initialized project already owns an npm lockfile. Equivalent commands are provided instead of replacing the package manager.
4. Hosted authentication uses the platform-provided authenticated identity. The role selector in the demo is an explicit product-preview affordance, not an authentication control.
5. The seeded organizations, people, addresses, identifiers, prices, and evidence descriptions are fictional.
6. No chemical application, pesticide rate, mixing, safety, or regulatory instruction is included.
7. Photos in the MVP are represented by attributable evidence records and optional local upload previews. Production storage uses signed R2 operations and malware scanning.
8. The scoring models are transparent heuristics intended for operator review, not trained machine-learning models.
9. New organizations default to `SUGGEST_ONLY`; appointment approval remains a human action.
10. The production scope still requires external identity lifecycle management, a full background queue service, provider credentials, formal accessibility testing, and jurisdiction-specific legal review.
