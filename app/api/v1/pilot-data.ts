import type { Role } from "../../../packages/domain/authorization";

export const PILOT_RECORDS = {
  organizationId: "ORG-NORTHSTAR",
  organizationName: "Northstar Pest",
  secondaryOrganizationId: "ORG-LAKESHORE",
  primaryBranchId: "BR-HUNTLEY",
  secondaryBranchId: "BR-CRYSTAL-LAKE",
  customerId: "CUS-118",
  propertyId: "PROP-118",
  zoneId: "ZONE-BASEMENT",
  serviceRequestId: "SR-1048",
  jobId: "JOB-2048",
  playbookVersionId: "PBV-ROD-3.2",
  integrationConnectionId: "INT-MOCK-FSM",
} as const;

export type PilotIdentity = {
  email: string;
  displayName: string;
  isLocalDemo: boolean;
  requestedPersona?: string | null;
};

export type PilotMembership = {
  organizationId: string;
  organizationName: string;
  autonomyLevel: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  technicianId: string | null;
};

type MembershipRow = {
  organization_id: string;
  organization_name: string;
  autonomy_level: string;
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  technician_id: string | null;
};

const LOCAL_PERSONAS = {
  OWNER: {
    email: "owner@northstar.demo",
    displayName: "Morgan Reed",
    role: "OWNER",
    technicianId: "TECH-04",
  },
  DISPATCHER: {
    email: "dispatcher@northstar.demo",
    displayName: "Riley Patel",
    role: "DISPATCHER",
    technicianId: null,
  },
  MANAGER: {
    email: "manager@northstar.demo",
    displayName: "Jordan Lee",
    role: "MANAGER",
    technicianId: null,
  },
  TECHNICIAN: {
    email: "maya.chen@northstar.demo",
    displayName: "Maya Chen",
    role: "TECHNICIAN",
    technicianId: "TECH-04",
  },
  OTHER_TECHNICIAN: {
    email: "andre.silva@northstar.demo",
    displayName: "Andre Silva",
    role: "TECHNICIAN",
    technicianId: "TECH-07",
  },
  READ_ONLY: {
    email: "auditor@northstar.demo",
    displayName: "Taylor Brooks",
    role: "READ_ONLY",
    technicianId: null,
  },
} as const satisfies Record<
  string,
  {
    email: string;
    displayName: string;
    role: Role;
    technicianId: string | null;
  }
>;

export async function ensurePilotMembership(
  db: D1Database,
  identity: PilotIdentity,
  requestedOrganizationId: string = PILOT_RECORDS.organizationId,
): Promise<PilotMembership | null> {
  const now = Date.now();
  await ensurePilotFoundation(db, now);

  const persona =
    identity.isLocalDemo && identity.requestedPersona
      ? LOCAL_PERSONAS[
          identity.requestedPersona.toUpperCase() as keyof typeof LOCAL_PERSONAS
        ]
      : null;
  const effectiveIdentity = persona ?? {
    email: identity.email,
    displayName: identity.displayName,
    role: "OWNER" as const,
    // The private hosted pilot owner is also the designated TECH-04 field
    // operator. A future shared deployment must provision these links
    // explicitly through membership administration.
    technicianId: "TECH-04",
  };

  const existing = await findActiveMembership(
    db,
    requestedOrganizationId,
    effectiveIdentity.email,
  );
  if (existing) return toPilotMembership(existing);

  if (requestedOrganizationId !== PILOT_RECORDS.organizationId) return null;

  // The private hosted pilot may bootstrap exactly one owner. Once any
  // membership exists, an authenticated platform user must be explicitly
  // provisioned; merely reaching the URL never grants organization access.
  if (!identity.isLocalDemo) {
    const claimed = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM organization_memberships
         WHERE organization_id = ?`,
      )
      .bind(PILOT_RECORDS.organizationId)
      .first<{ count: number }>();
    if ((claimed?.count ?? 0) > 0) return null;
  }

  const normalizedEmail = effectiveIdentity.email.toLowerCase();
  const candidateUserId = `USR-${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO users
        (id, email, display_name, password_hash, status, created_at,
         updated_at, version)
       VALUES (?, ?, ?, NULL, 'ACTIVE', ?, ?, 1)`,
    )
    .bind(
      candidateUserId,
      normalizedEmail,
      effectiveIdentity.displayName,
      now,
      now,
    )
    .run();
  const user = await db
    .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
    .bind(normalizedEmail)
    .first<{ id: string }>();
  if (!user) return null;

  const userId = user.id;
  const membershipId = identity.isLocalDemo
    ? `MEM-${PILOT_RECORDS.organizationId}-${userId}`
    : `MEM-${PILOT_RECORDS.organizationId}-PRIMARY-OWNER`;

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO organization_memberships
          (id, organization_id, user_id, role, technician_id, status,
           created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 1)`,
      )
      .bind(
        membershipId,
        PILOT_RECORDS.organizationId,
        userId,
        effectiveIdentity.role,
        effectiveIdentity.technicianId,
        now,
        now,
      ),
  ]);

  const row = await findActiveMembership(
    db,
    requestedOrganizationId,
    normalizedEmail,
  );
  return row ? toPilotMembership(row) : null;
}

async function findActiveMembership(
  db: D1Database,
  organizationId: string,
  email: string,
) {
  return db
    .prepare(
      `SELECT m.organization_id, o.name AS organization_name,
              o.autonomy_level, u.id AS user_id, u.email, u.display_name,
              m.role, m.technician_id
       FROM organization_memberships m
       JOIN organizations o ON o.id = m.organization_id
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND u.email = ?
         AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
       LIMIT 1`,
    )
    .bind(organizationId, email.toLowerCase())
    .first<MembershipRow>();
}

function toPilotMembership(row: MembershipRow): PilotMembership {
  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    autonomyLevel: row.autonomy_level,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    technicianId: row.technician_id,
  };
}

export async function ensurePilotOperationalData(
  db: D1Database,
  actorUserId: string,
) {
  const now = Date.now();
  const tomorrow = now + 24 * 60 * 60 * 1000;
  const verificationDue = now + 7 * 24 * 60 * 60 * 1000;
  const requiredEvidence = JSON.stringify([
    { phase: "BEFORE", subject: "AREA_OVERVIEW", minimum: 1 },
    { phase: "DURING", subject: "ENTRY_POINT", minimum: 1 },
  ]);
  const steps = JSON.stringify([
    "Inspect basement perimeter and sill plates",
    "Inspect utility penetrations and accessible voids",
    "Document signs, conditions, and potential entry points",
    "Review unresolved risks and follow-up requirement",
  ]);

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO customers
          (id, organization_id, name, contact_policy, email, phone, status,
           created_at, updated_at, version)
         VALUES (?, ?, 'Jamie Morrison', 'SMS_ALLOWED',
                 'jamie.morrison@example.test', '+1-224-555-0118', 'ACTIVE',
                 ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.customerId,
        PILOT_RECORDS.organizationId,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO properties
          (id, organization_id, customer_id, branch_id, address,
           property_type, completeness_score, recurrence_risk_score,
           recurring_plan_status, open_risks_json, next_inspection_at,
           status, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, '1428 Redtail Lane, Huntley, IL 60142',
                 'SINGLE_FAMILY', 80, 32, 'ACTIVE', '[]', ?, 'ACTIVE',
                 ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.propertyId,
        PILOT_RECORDS.organizationId,
        PILOT_RECORDS.customerId,
        PILOT_RECORDS.primaryBranchId,
        verificationDue,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO property_zones
          (id, organization_id, property_id, name, created_at, updated_at,
           version)
         VALUES (?, ?, ?, 'Basement', ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.zoneId,
        PILOT_RECORDS.organizationId,
        PILOT_RECORDS.propertyId,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO service_requests
          (id, organization_id, property_id, source, description,
           issue_category, confidence, serviceability, status, triage_json,
           received_at, created_by_user_id, created_at, updated_at, version)
         VALUES (?, ?, ?, 'SIMULATED_SMS',
                 'Mouse droppings reported along the basement wall near the utility panel.',
                 NULL, NULL, NULL, 'NEW', NULL, ?, ?, ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.serviceRequestId,
        PILOT_RECORDS.organizationId,
        PILOT_RECORDS.propertyId,
        now,
        actorUserId,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO playbook_versions
          (id, organization_id, service_type, version_label, status,
           effective_at, steps_json, required_evidence_json, aftercare_json,
           created_at, updated_at, version)
         VALUES (?, ?, 'RODENT_ENTRY_POINT_INSPECTION', 'ROD v3.2',
                 'APPROVED', ?, ?, ?,
                 '["Keep the inspected area accessible for follow-up."]',
                 ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.playbookVersionId,
        PILOT_RECORDS.organizationId,
        now,
        steps,
        requiredEvidence,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO jobs
          (id, organization_id, service_request_id, property_id,
           playbook_version_id, technician_id, status, kind, parent_job_id,
           price_cents, actual_drive_minutes, actual_material_cost_cents,
           checked_in_at, completed_at, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, NULL, 'DRAFT', 'ORIGINAL', NULL, 18900,
                 NULL, NULL, NULL, NULL, ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.jobId,
        PILOT_RECORDS.organizationId,
        PILOT_RECORDS.serviceRequestId,
        PILOT_RECORDS.propertyId,
        PILOT_RECORDS.playbookVersionId,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO integration_connections
          (id, organization_id, provider, mode, status, capabilities_json,
           last_successful_sync_at, created_at, updated_at, version)
         VALUES (?, ?, 'MOCK', 'SHADOW_READ_ONLY', 'CONNECTED',
                 '["CUSTOMERS_READ","PROPERTIES_READ","JOBS_READ","PROOF_WRITEBACK"]',
                 NULL, ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.integrationConnectionId,
        PILOT_RECORDS.organizationId,
        now,
        now,
      ),
    ...scheduleCandidateStatements(db, now, tomorrow),
  ]);
}

async function ensurePilotFoundation(db: D1Database, now: number) {
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO organizations
          (id, name, autonomy_level, verification_interval_days,
           proof_delivery_mode, created_at, updated_at, version)
         VALUES (?, 'Northstar Pest', 'SUGGEST_ONLY', 7, 'MOCK', ?, ?, 1)`,
      )
      .bind(PILOT_RECORDS.organizationId, now, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO organizations
          (id, name, autonomy_level, verification_interval_days,
           proof_delivery_mode, created_at, updated_at, version)
         VALUES (?, 'Lakeshore Pest Demo', 'SUGGEST_ONLY', 7, 'MOCK',
                 ?, ?, 1)`,
      )
      .bind(PILOT_RECORDS.secondaryOrganizationId, now, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO branches
          (id, organization_id, name, territory, created_at, updated_at,
           version)
         VALUES (?, ?, 'Huntley Branch', 'Huntley, Illinois', ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.primaryBranchId,
        PILOT_RECORDS.organizationId,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO branches
          (id, organization_id, name, territory, created_at, updated_at,
           version)
         VALUES (?, ?, 'Crystal Lake Branch', 'Crystal Lake, Illinois',
                 ?, ?, 1)`,
      )
      .bind(
        PILOT_RECORDS.secondaryBranchId,
        PILOT_RECORDS.organizationId,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO branches
          (id, organization_id, name, territory, created_at, updated_at,
           version)
         VALUES ('BR-LAKESHORE', ?, 'Lakeshore Branch',
                 'Lake County, Illinois', ?, ?, 1)`,
      )
      .bind(PILOT_RECORDS.secondaryOrganizationId, now, now),
    ...technicianStatements(db, now),
  ]);
}

function technicianStatements(db: D1Database, now: number) {
  const technicians = [
    ["TECH-04", "Maya Chen", 3100, ["RODENT_INSPECTION", "HUNTLEY"]],
    ["TECH-07", "Andre Silva", 2900, ["RODENT_INSPECTION", "HUNTLEY"]],
    ["TECH-02", "Eli Brooks", 3400, ["RODENT_INSPECTION", "HUNTLEY"]],
    ["TECH-09", "Sam Okafor", 3200, ["GENERAL_PEST", "CRYSTAL_LAKE"]],
    ["TECH-11", "Jordan Kim", 3000, ["GENERAL_PEST", "ALGONQUIN"]],
    ["TECH-12", "Casey Nguyen", 3300, ["CALLBACK", "HUNTLEY"]],
    ["TECH-14", "Avery Davis", 3050, ["STINGING_INSECT", "HUNTLEY"]],
    ["TECH-15", "Devon Walker", 3500, ["WDO_INSPECTION", "CRYSTAL_LAKE"]],
  ] as const;
  return technicians.map(([id, name, rate, skills]) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO technicians
          (id, organization_id, branch_id, user_id, display_name, status,
           labor_cost_per_hour_cents, skills_json, created_at, updated_at,
           version)
         VALUES (?, ?, ?, NULL, ?, 'ACTIVE', ?, ?, ?, ?, 1)`,
      )
      .bind(
        id,
        PILOT_RECORDS.organizationId,
        id === "TECH-15"
          ? PILOT_RECORDS.secondaryBranchId
          : PILOT_RECORDS.primaryBranchId,
        name,
        rate,
        JSON.stringify(skills),
        now,
        now,
      ),
  );
}

function scheduleCandidateStatements(
  db: D1Database,
  today: number,
  tomorrow: number,
) {
  const candidates = [
    ["SC-2401", "TECH-04", today + 60 * 60 * 1000, 12305, 155.05],
    ["SC-2402", "TECH-07", today + 3 * 60 * 60 * 1000, 11278, 123.78],
    ["SC-2403", "TECH-02", tomorrow, 12384, 147.84],
  ] as const;
  return candidates.map(([id, technicianId, startsAt, contribution, score]) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO schedule_candidates
          (id, organization_id, service_request_id, technician_id, starts_at,
           expected_contribution, score, explanation_json, approved_at,
           created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
      )
      .bind(
        id,
        PILOT_RECORDS.organizationId,
        PILOT_RECORDS.serviceRequestId,
        technicianId,
        startsAt,
        contribution / 100,
        score,
        JSON.stringify({
          policyVersion: "schedule-economics-v2",
          source: "seeded deterministic Huntley candidate",
        }),
        today,
        today,
      ),
  );
}
