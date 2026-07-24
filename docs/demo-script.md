# Demo script

1. Open **Control Tower**, restart the fictional workflow, and select the
   Morrison priority request.
2. Generate the AI triage proposal. Review the source facts, confidence,
   serviceability, ambiguity, and safety flags, then record explicit human
   approval.
3. Open the ranked slots. Compare expected price, labor, drive, material,
   reservice, route-density, and penalty contributions.
4. Approve **Maya Chen · Today 1:30 PM** and confirm assignment
   `SC-2401 · TECH-04`.
5. In **Jobs**, check in and review the sourced pre-job brief and pinned
   playbook version.
6. Complete all four inspection steps.
7. Upload a PNG using `BEFORE / AREA_OVERVIEW`, then a second using
   `DURING / ENTRY_POINT`. Add a caption and confirm the typed evidence policy
   passes; file count alone is insufficient.
8. Record the basement observation, mark the entry-point risk unresolved, and
   enter actual drive minutes, material cost, and a technician completion note.
9. Select **Mark field work complete & generate proof**. Confirm:
   - field work is complete;
   - the immutable proof has a SHA-256 fingerprint;
   - the technician assessment records open risk; and
   - the outcome remains **Pending verification — no resolution claim yet**.
10. Queue Service Proof delivery. Confirm that `QUEUED` is not presented as
    delivered, then use **Process mock delivery** and inspect the deterministic
    provider receipt.
11. As a different authorized local-demo actor, attest to the
    customer-confirmed outcome. The record identifies the staff verifier and
    source as `STAFF_RECORDED_CUSTOMER_CONFIRMATION`; a self-verification or
    unreceipted direct-customer source is rejected. The pilot result becomes
    `RESOLVED`, as a different event from field completion.
12. Optionally link a reservice and direct cost. Confirm the original job keeps
    its history while final contribution and the current outcome update.
13. Reload and inspect **Playbooks**, **Outcomes**, **Integrations**,
    **Exceptions**, and **Audit**. Run a mock shadow sync and inspect
    reconciliation and outbox/dead-letter counts.
14. Demonstrate offline truth by disconnecting after the signed-in app is open:
    field operations are journaled locally and remain unconfirmed until replay.
    A cold offline navigation shows only the neutral offline page; it never
    replays authenticated HTML or API content.

This script proves repository behavior with fictional records and mock adapters.
It does not prove live vendor compatibility, customer delivery, field adoption,
risk calibration, or production readiness.
