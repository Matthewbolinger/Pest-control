# FieldProof implementation assumptions

1. This delivery optimizes for a complete fictional Huntley
   request-to-verification vertical slice rather than shallow coverage of every
   administrative module.
2. FieldProof is an outcome-assurance layer beside an FSM. Appointment, route,
   price, invoice, payment, payroll, and regulatory treatment authority remain
   external.
3. The existing Sites/Vinext foundation is preserved. Cloudflare D1 and R2 are
   the deployed pilot stores; domain and adapter boundaries preserve a future
   service/worker split.
4. Hosted authentication uses platform identity. Each request resolves a
   database-backed membership and default-deny role permissions. The private
   pilot automatically provisions its owner; shared membership invitation,
   administration, suspension, and removal remain production work.
5. Seeded organizations, people, addresses, identifiers, prices, outcomes, and
   evidence descriptions are fictional.
6. No chemical application, pesticide rate, mixing, safety, guarantee, or
   regulatory instruction is included.
7. Evidence is typed and attributable; private bytes are stored in R2 in the
   deployed pilot. Production still requires malware scanning and approved
   retention/deletion rules.
8. Field completion proves the configured work and facts, not customer
   resolution. Independent verification is required, and unknown outcomes are
   not counted as success.
9. Risk and scoring models are transparent deterministic heuristics for
   operator review, not trained or field-calibrated models.
10. New organizations default to `SUGGEST_ONLY`; triage advancement and
    appointment approval remain explicit human actions.
11. The mock FSM, mock communications adapter, and CSV contracts prove local
    behavior only. Vendor compatibility and customer delivery require current
    documentation, credentials, sandbox evidence, and reconciliation.
12. IndexedDB stores unconfirmed, actor-scoped operations and attachments.
    Server receipts remain authoritative. The PWA caches only public assets and
    intentionally provides a neutral cold-offline page.
13. **Restart demo workflow** is a destructive, owner-only demo convenience.
    It clears repeatable operational projections for the seeded job, including
    appointments, outcomes, generated proof/delivery rows, reservice children,
    and their delivery outbox work. It preserves audit events, command
    receipts, evidence assets, customer/property/playbook master records, and
    integration history. It is not a production data-erasure control.
14. Production scope still requires real partner field trials, calibrated risk
    and observation windows, production delivery, security/privacy/legal/
    accessibility review, and backup/restore/disaster-recovery validation.
