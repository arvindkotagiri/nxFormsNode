import { pool } from "../db";
import { hashPassword } from "../utils/password";

export function extractOutputFieldsFromCatalog(fieldsData: unknown) {
  const result: Array<{ entity: string; name: string; label: string; type: string | null }> = [];
  if (!fieldsData || typeof fieldsData !== "object") return result;

  for (const [entity, fieldList] of Object.entries(fieldsData as Record<string, unknown>)) {
    const arr = Array.isArray(fieldList) ? fieldList : [];
    for (const field of arr) {
      if (!field || typeof field !== "object") continue;
      const f = field as Record<string, unknown>;
      if (!f.showInOutputDefinition) continue;
      const name = (f.name || f.originalName) as string | undefined;
      if (!name) continue;
      result.push({
        entity,
        name,
        label: (f.label as string) || name,
        type: (f.type as string) || null,
      });
    }
  }

  return result;
}

export async function upsertOutputDefinitionRecord(
  contextId: number,
  name: string,
  endpoint: string,
  fieldsData: unknown,
  actor = "system",
) {
  const outputFields = extractOutputFieldsFromCatalog(fieldsData);
  await pool.query(
    `
    INSERT INTO api_output_definitions (
      context_id, name, endpoint, output_fields, created_by, updated_by, updated_on
    )
    VALUES ($1, $2, $3, $4::jsonb, $5, $5, NOW())
    ON CONFLICT (context_id) DO UPDATE SET
      name = EXCLUDED.name,
      endpoint = EXCLUDED.endpoint,
      output_fields = EXCLUDED.output_fields,
      updated_by = EXCLUDED.updated_by,
      updated_on = NOW()
    `,
    [contextId, name, endpoint, JSON.stringify(outputFields), actor],
  );
}

export async function syncAllOutputDefinitionsFromContexts() {
  const contexts = await pool.query("SELECT id, name, endpoint, fields FROM contexts");
  for (const ctx of contexts.rows) {
    const fields =
      typeof ctx.fields === "string"
          ? JSON.parse(ctx.fields)
          : ctx.fields || {};
    await upsertOutputDefinitionRecord(ctx.id, ctx.name, ctx.endpoint, fields, "system");
  }
}

export async function initApiCatalogDb(): Promise<void> {
  const client = await pool.connect();
  try {
    // 1. Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        password_hash TEXT NOT NULL,
        encrypted_payload TEXT,
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed default configurator user if none exist
    const userCheck = await client.query("SELECT 1 FROM users LIMIT 1");
    if (userCheck.rowCount === 0) {
      const passwordHash = await hashPassword("pass1234");
      await client.query(
        `INSERT INTO users (email, name, role, password_hash, created_by, created_on, updated_by, updated_on)
         VALUES ($1, $2, $3, $4, 'system', NOW(), 'system', NOW())`,
        ["configurator@test.com", "Configurator", "configurator", passwordHash]
      );
      console.log("[db] Seeded default configurator user");
    }

    // 2. Create events table
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_number SERIAL,
        source TEXT,
        context TEXT,
        entity_key TEXT,
        event_type TEXT,
        triggered_by TEXT,
        print_to_file TEXT,
        form TEXT,
        payload TEXT,
        status TEXT DEFAULT 'Pending',
        event_timestamp TIMESTAMPTZ DEFAULT NOW(),
        duration_ms INTEGER,
        outputs INTEGER DEFAULT 0,
        error_message TEXT,
        encrypted_payload TEXT,
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 3. Create outputs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS outputs (
        output_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id UUID REFERENCES events(event_id) ON DELETE CASCADE,
        form_id TEXT,
        printer TEXT,
        format TEXT,
        status TEXT DEFAULT 'Pending',
        retries INTEGER DEFAULT 0,
        duration INTEGER,
        error_message TEXT,
        rendered_output TEXT,
        encrypted_payload TEXT,
        output_number SERIAL,
        document_json TEXT,
        completed_at TIMESTAMPTZ,
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 4. Create simulation_master table
    await client.query(`
      CREATE TABLE IF NOT EXISTS simulation_master (
        id SERIAL PRIMARY KEY,
        simulation_name TEXT NOT NULL,
        context TEXT NOT NULL,
        form TEXT,
        input_values JSONB DEFAULT '{}'::jsonb,
        encrypted_payload TEXT,
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 5. Create logs_audit table
    await client.query(`
      CREATE TABLE IF NOT EXISTS logs_audit (
        log_id SERIAL PRIMARY KEY,
        level TEXT NOT NULL,
        service TEXT NOT NULL,
        message TEXT NOT NULL,
        username TEXT,
        trace_id TEXT,
        metadata JSONB,
        event_timestamp TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT,
        created_on TIMESTAMPTZ DEFAULT NOW(),
        updated_by TEXT,
        updated_on TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS contexts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        auth_type TEXT,
        auth_url TEXT,
        client_id TEXT,
        client_secret TEXT,
        fields JSONB,
        entities JSONB,
        username TEXT,
        password TEXT,
        status TEXT DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        application TEXT,
        environment TEXT,
        client NUMERIC(3)
      );
    `);

    await client.query(`
      ALTER TABLE contexts
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS password TEXT,
      ADD COLUMN IF NOT EXISTS application TEXT,
      ADD COLUMN IF NOT EXISTS environment TEXT,
      ADD COLUMN IF NOT EXISTS client NUMERIC(3);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_output_definitions (
        id SERIAL PRIMARY KEY,
        context_id INTEGER UNIQUE REFERENCES contexts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        output_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by TEXT,
        updated_by TEXT,
        updated_on TIMESTAMPTZ
      );
    `);

    const labelConfigs = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'label_configs'
      LIMIT 1
    `);
    if ((labelConfigs.rowCount ?? 0) > 0) {
      await client.query(`
        ALTER TABLE label_configs
        ADD COLUMN IF NOT EXISTS output_conditions JSONB DEFAULT '{}'::jsonb
      `);
    }

    await syncAllOutputDefinitionsFromContexts();
    console.log("[db] API catalog + output definition tables ready");
  } finally {
    client.release();
  }
}
