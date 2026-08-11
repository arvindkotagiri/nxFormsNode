import { pool } from "../db";

const AUDIT_TABLES = [
  "label_configs",
  "events",
  "outputs",
  "simulation_master",
  "contexts",
  "api_output_definitions",
  "users",
  "logs_audit",
  "ref_customers",
  "ref_plants",
  "ref_company_codes",
  "ref_sales_orgs",
  "ref_warehouses",
  "ref_shipping_points",
  "ref_process_types",
  "ref_labels",
  "label_master",
  "printer_master",
] as const;

async function tableExists(table: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1
     LIMIT 1`,
    [table]
  );
  return (r.rowCount ?? 0) > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return (r.rowCount ?? 0) > 0;
}

async function renameColumn(table: string, from: string, to: string): Promise<void> {
  if (!(await columnExists(table, from)) || (await columnExists(table, to))) return;
  await pool.query(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
}

async function addAuditColumns(table: string): Promise<void> {
  await pool.query(`
    ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS created_by TEXT,
      ADD COLUMN IF NOT EXISTS created_on TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_by TEXT,
      ADD COLUMN IF NOT EXISTS updated_on TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS encrypted_payload TEXT
  `);
}

async function migrateLabelConfigs(): Promise<void> {
  await renameColumn("label_configs", "created_at", "created_on");
  await renameColumn("label_configs", "changed_at", "updated_on");
  await renameColumn("label_configs", "changed_by", "updated_by");
  await addAuditColumns("label_configs");
  await pool.query(`
    UPDATE label_configs
    SET
      created_on = COALESCE(created_on, NOW()),
      updated_on = COALESCE(updated_on, created_on, NOW()),
      updated_by = COALESCE(updated_by, created_by)
    WHERE created_on IS NULL OR updated_on IS NULL OR updated_by IS NULL
  `);
}

async function migrateOutputs(): Promise<void> {
  await renameColumn("outputs", "created_at", "created_on");
  await addAuditColumns("outputs");
  await pool.query(`
    UPDATE outputs
    SET
      created_on = COALESCE(created_on, NOW()),
      updated_on = COALESCE(updated_on, created_on, NOW()),
      updated_by = COALESCE(updated_by, created_by, 'system'),
      created_by = COALESCE(created_by, 'system')
    WHERE created_on IS NULL
  `);
}

async function migrateSimulation(): Promise<void> {
  await renameColumn("simulation_master", "created_at", "created_on");
  await renameColumn("simulation_master", "updated_at", "updated_on");
  await addAuditColumns("simulation_master");
  await pool.query(`
    UPDATE simulation_master
    SET
      created_on = COALESCE(created_on, NOW()),
      updated_on = COALESCE(updated_on, created_on, NOW()),
      updated_by = COALESCE(updated_by, created_by, 'system'),
      created_by = COALESCE(created_by, 'system')
    WHERE created_on IS NULL
  `);
}

async function migrateUsers(): Promise<void> {
  await renameColumn("users", "created_at", "created_on");
  await addAuditColumns("users");
  await pool.query(`
    UPDATE users
    SET
      created_on = COALESCE(created_on, NOW()),
      updated_on = COALESCE(updated_on, created_on, NOW()),
      updated_by = COALESCE(updated_by, created_by, email),
      created_by = COALESCE(created_by, email)
    WHERE created_on IS NULL
  `);
}

async function migrateEvents(): Promise<void> {
  await addAuditColumns("events");
  if (await columnExists("events", "triggered_by")) {
    await pool.query(`
      UPDATE events
      SET created_by = COALESCE(created_by, triggered_by)
      WHERE created_by IS NULL AND triggered_by IS NOT NULL
    `);
  }
  if (await columnExists("events", "event_timestamp")) {
    await pool.query(`
      UPDATE events
      SET created_on = COALESCE(created_on, event_timestamp)
      WHERE created_on IS NULL AND event_timestamp IS NOT NULL
    `);
  }
  await pool.query(`
    UPDATE events
    SET
      updated_on = COALESCE(updated_on, created_on, NOW()),
      updated_by = COALESCE(updated_by, created_by)
    WHERE updated_on IS NULL
  `);
}

async function migrateContexts(): Promise<void> {
  await renameColumn("contexts", "created_at", "created_on");
  await addAuditColumns("contexts");
  await pool.query(`
    UPDATE contexts
    SET
      created_on = COALESCE(created_on, NOW()),
      updated_on = COALESCE(updated_on, created_on, NOW())
    WHERE created_on IS NULL
  `);
}

async function migrateLogsAudit(): Promise<void> {
  await addAuditColumns("logs_audit");
  if (await columnExists("logs_audit", "username")) {
    await pool.query(`
      UPDATE logs_audit
      SET created_by = COALESCE(created_by, username)
      WHERE created_by IS NULL AND username IS NOT NULL
    `);
  }
  if (await columnExists("logs_audit", "event_timestamp")) {
    await pool.query(`
      UPDATE logs_audit
      SET created_on = COALESCE(created_on, event_timestamp)
      WHERE created_on IS NULL
    `);
  }
  if (await columnExists("logs_audit", "created_at")) {
    await pool.query(`
      UPDATE logs_audit
      SET created_on = COALESCE(created_on, created_at)
      WHERE created_on IS NULL
    `);
  }
}

async function migrateImageMaster(): Promise<void> {
  await addAuditColumns("image_master");
  if (await columnExists("image_master", "created_at")) {
    await pool.query(`
      UPDATE image_master
      SET created_on = COALESCE(created_on, created_at)
      WHERE created_on IS NULL
    `);
  }
  if (await columnExists("image_master", "updated_at")) {
    await pool.query(`
      UPDATE image_master
      SET updated_on = COALESCE(updated_on, updated_at)
      WHERE updated_on IS NULL
    `);
  }
}

export async function ensureAuditColumns(): Promise<void> {
  try {
    for (const table of AUDIT_TABLES) {
      try {
        if (!(await tableExists(table))) continue;
        await addAuditColumns(table);
      } catch (e) {
        console.error(`[db] Error adding audit columns to ${table}:`, e);
      }
    }

    if (await tableExists("label_configs")) { try { await migrateLabelConfigs(); } catch (e) { console.error("[db] migrateLabelConfigs error:", e); } }
    if (await tableExists("outputs")) { try { await migrateOutputs(); } catch (e) { console.error("[db] migrateOutputs error:", e); } }
    if (await tableExists("simulation_master")) { try { await migrateSimulation(); } catch (e) { console.error("[db] migrateSimulation error:", e); } }
    if (await tableExists("users")) { try { await migrateUsers(); } catch (e) { console.error("[db] migrateUsers error:", e); } }
    if (await tableExists("events")) { try { await migrateEvents(); } catch (e) { console.error("[db] migrateEvents error:", e); } }
    if (await tableExists("contexts")) { try { await migrateContexts(); } catch (e) { console.error("[db] migrateContexts error:", e); } }
    if (await tableExists("logs_audit")) { try { await migrateLogsAudit(); } catch (e) { console.error("[db] migrateLogsAudit error:", e); } }
    if (await tableExists("image_master")) { try { await migrateImageMaster(); } catch (e) { console.error("[db] migrateImageMaster error:", e); } }

    console.log("[db] Audit columns ensured on application tables");
  } catch (err) {
    console.error("[db] ensureAuditColumns unexpected error:", err);
  }
}
