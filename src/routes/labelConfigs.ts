import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
// import { requireUser, requireConfigurator, AuthedRequest } from "../middleware/auth";
import { requireConfigurator, AuthedRequest } from "../middleware/auth";
import { auditActor, AUDIT_SELECT_SQL } from "../utils/audit";
import { buildEncryptedPayload, maybeDecryptPayload } from "../utils/dataEncryption";

const router = Router();

/**
 * Matches your FastAPI schemas:
 * LabelConfigurationCreate, LabelConfigurationUpdate
 */
const labelConfigCreateSchema = z.object({
  label_name: z.string().min(1),
  label_id: z.string().min(1),

  customer: z.string().optional().nullable(),
  plant: z.string().optional().nullable(),
  company_code: z.string().optional().nullable(),
  sales_organization: z.string().optional().nullable(),
  warehouse: z.string().optional().nullable(),
  shipping_point: z.string().optional().nullable(),
  process_type: z.string().optional().nullable(),

  number_of_labels: z.number().int().min(0).optional().default(1),
  priority: z.number().int().min(1),
  active: z.boolean().optional().default(true),

  valid_from: z.string().optional().nullable(), // ISO date string expected from frontend
  valid_to: z.string().optional().nullable(),
  printer: z.string().optional().nullable(),
  output_conditions: z.record(z.string(), z.string()).optional().nullable(),
});

const labelConfigUpdateSchema = labelConfigCreateSchema.partial();

/**
 * STEP 7: Validate reference fields exist in Postgres reference tables
 * (prevents invalid values even if someone calls API manually)
 *
 * NOTE: table name is a constant we control in code (not user input), so it's safe to interpolate.
 */
async function assertRefExists(table: string, id: string, label: string) {
  const r = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  if (r.rowCount === 0) {
    const err: any = new Error(`${label} not found: ${id}`);
    err.statusCode = 400;
    throw err;
  }
}

async function assertFormExists(table: string, id: string, label: string) {
  console.log("Props", table, id, label);
  const r = await pool.query(`SELECT 1 FROM ${table} WHERE label_id = $1 LIMIT 1`, [id]);
  if (r.rowCount === 0) {
    const err: any = new Error(`${label} not found: ${id}`);
    err.statusCode = 400;
    throw err;
  }
}

async function validateRefsForCreate(body: z.infer<typeof labelConfigCreateSchema>) {
  // Only validate if values are provided (non-null/ non-empty)
  if (body.customer) await assertRefExists("ref_customers", body.customer, "Customer");
  if (body.plant) await assertRefExists("ref_plants", body.plant, "Plant");
  if (body.company_code) await assertRefExists("ref_company_codes", body.company_code, "Company code");
  if (body.sales_organization) await assertRefExists("ref_sales_orgs", body.sales_organization, "Sales org");
  if (body.warehouse) await assertRefExists("ref_warehouses", body.warehouse, "Warehouse");
  if (body.shipping_point) await assertRefExists("ref_shipping_points", body.shipping_point, "Shipping point");
  if (body.process_type) await assertRefExists("ref_process_types", body.process_type, "Process type");
  if (body.label_id) await assertFormExists("label_master", body.label_id, "Label");
  if (body.printer) await assertRefExists("printer_master", body.printer, "Printer");
}

async function validateRefsForUpdate(body: z.infer<typeof labelConfigUpdateSchema>) {
  // Validate only fields that are being updated (provided !== undefined)
  // (If provided as null/empty string, we treat as clearing the field -> no validation needed)
  if (body.customer !== undefined && body.customer) await assertRefExists("ref_customers", body.customer, "Customer");
  if (body.plant !== undefined && body.plant) await assertRefExists("ref_plants", body.plant, "Plant");
  if (body.company_code !== undefined && body.company_code) await assertRefExists("ref_company_codes", body.company_code, "Company code");
  if (body.sales_organization !== undefined && body.sales_organization) await assertRefExists("ref_sales_orgs", body.sales_organization, "Sales org");
  if (body.warehouse !== undefined && body.warehouse) await assertRefExists("ref_warehouses", body.warehouse, "Warehouse");
  if (body.shipping_point !== undefined && body.shipping_point) await assertRefExists("ref_shipping_points", body.shipping_point, "Shipping point");
  if (body.process_type !== undefined && body.process_type) await assertRefExists("ref_process_types", body.process_type, "Process type");
  if (body.label_id !== undefined && body.label_id) await assertFormExists("label_master", body.label_id, "Label");
  if (body.printer !== undefined && body.printer) await assertRefExists("printer_master", body.printer, "Printer");
}

/**
 * GET /api/label-configs
 * Supports filters like your FastAPI:
 * label_name (contains), customer, plant, warehouse, process_type, active
 */
// router.get("/", requireUser, async (req, res) => {
router.get("/", async (req, res) => {
  const {
    label_name,
    customer,
    plant,
    warehouse,
    process_type,
    active,
  } = req.query as Record<string, string | undefined>;

  const where: string[] = [];
  const values: any[] = [];
  let i = 1;

  if (label_name) {
    where.push(`label_name ILIKE $${i++}`);
    values.push(`%${label_name}%`);
  }
  if (customer) {
    where.push(`customer = $${i++}`);
    values.push(customer);
  }
  if (plant) {
    where.push(`plant = $${i++}`);
    values.push(plant);
  }
  if (warehouse) {
    where.push(`warehouse = $${i++}`);
    values.push(warehouse);
  }
  if (process_type) {
    where.push(`process_type = $${i++}`);
    values.push(process_type);
  }
  if (active !== undefined) {
    where.push(`active = $${i++}`);
    values.push(active === "true");
  }

  const sql = `
    SELECT
      config_id::text,
      label_name,
      label_id,
      customer,
      plant,
      company_code,
      sales_organization,
      warehouse,
      shipping_point,
      process_type,
      number_of_labels,
      priority,
      active,
      to_char(valid_from, 'YYYY-MM-DD') as valid_from,
      to_char(valid_to, 'YYYY-MM-DD') as valid_to,
      printer,
      encrypted_payload,
      ${AUDIT_SELECT_SQL}
    FROM label_configs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY priority ASC
    LIMIT 1000;
  `;

  const result = await pool.query(sql, values);
  const formatted = result.rows.map((r) => {
    let decryptedPayload: any = null;
    if (r.encrypted_payload) {
      try {
        decryptedPayload = maybeDecryptPayload(r.encrypted_payload) as any;
      } catch (err) {
        console.warn("Failed to decrypt label config payload:", err);
      }
    }

    return {
      config_id: r.config_id,
      label_name: decryptedPayload?.label_name ?? r.label_name,
      label_id: decryptedPayload?.label_id ?? r.label_id,
      customer: decryptedPayload?.customer ?? r.customer,
      plant: decryptedPayload?.plant ?? r.plant,
      company_code: decryptedPayload?.company_code ?? r.company_code,
      sales_organization: decryptedPayload?.sales_organization ?? r.sales_organization,
      warehouse: decryptedPayload?.warehouse ?? r.warehouse,
      shipping_point: decryptedPayload?.shipping_point ?? r.shipping_point,
      process_type: decryptedPayload?.process_type ?? r.process_type,
      number_of_labels: decryptedPayload?.number_of_labels ?? r.number_of_labels,
      priority: decryptedPayload?.priority ?? r.priority,
      active: decryptedPayload?.active ?? r.active,
      valid_from: decryptedPayload?.valid_from ?? r.valid_from,
      valid_to: decryptedPayload?.valid_to ?? r.valid_to,
      printer: decryptedPayload?.printer ?? r.printer,
      created_by: r.created_by,
      created_on: r.created_on,
      updated_by: r.updated_by,
      updated_on: r.updated_on,
    };
  });

  return res.json(formatted);
});

/**
 * POST /api/label-configs
 * configurator only
 */
// router.post("/", requireUser, requireConfigurator, async (req: AuthedRequest, res) => {
router.post("/", async (req: AuthedRequest, res) => {
  const parsed = labelConfigCreateSchema.safeParse(req.body);
  console.log(parsed);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.flatten() });

  const body = parsed.data;
  const nowUser = auditActor(req, "Unknown");

  // STEP 7: reference validation
  try {
    await validateRefsForCreate(body);
  } catch (e: any) {
    return res.status(e.statusCode || 400).json({ detail: e.message || "Invalid reference" });
  }

  const encryptedPayload = buildEncryptedPayload({
    label_name: body.label_name,
    label_id: body.label_id,
    customer: body.customer ?? null,
    plant: body.plant ?? null,
    company_code: body.company_code ?? null,
    sales_organization: body.sales_organization ?? null,
    warehouse: body.warehouse ?? null,
    shipping_point: body.shipping_point ?? null,
    process_type: body.process_type ?? null,
    number_of_labels: body.number_of_labels,
    priority: body.priority,
    active: body.active,
    valid_from: body.valid_from ?? null,
    valid_to: body.valid_to ?? null,
    printer: body.printer ?? null,
    output_conditions: body.output_conditions ?? {},
    created_by: nowUser,
    updated_by: nowUser,
  });

  const insertSql = `
    INSERT INTO label_configs (
      label_name, label_id,
      customer, plant, company_code, sales_organization, warehouse, shipping_point, process_type,
      number_of_labels, priority, active,
      valid_from, valid_to,
      printer, output_conditions,
      created_by, created_on, updated_by, updated_on, encrypted_payload
    )
    VALUES (
      $1,$2,
      $3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,
      $13::date,$14::date,
      $15, $16::jsonb,
      $17, NOW(), $18, NOW(), $19
    )
    RETURNING
      config_id::text,
      label_name,
      label_id,
      customer,
      plant,
      company_code,
      sales_organization,
      warehouse,
      shipping_point,
      process_type,
      number_of_labels,
      priority,
      active,
      to_char(valid_from, 'YYYY-MM-DD') as valid_from,
      to_char(valid_to, 'YYYY-MM-DD') as valid_to,
      printer,
      ${AUDIT_SELECT_SQL};
  `;

  const values = [
    body.label_name,
    body.label_id,
    body.customer ?? null,
    body.plant ?? null,
    body.company_code ?? null,
    body.sales_organization ?? null,
    body.warehouse ?? null,
    body.shipping_point ?? null,
    body.process_type ?? null,
    body.number_of_labels,
    body.priority,
    body.active,
    body.valid_from ?? null,
    body.valid_to ?? null,
    body.printer ?? null,
    JSON.stringify(body.output_conditions ?? {}),
    nowUser,
    nowUser,
    encryptedPayload,
  ];

  const result = await pool.query(insertSql, values);
  return res.json(result.rows[0]);
});

/**
 * GET /api/label-configs/:config_id
 */
// router.get("/:config_id", requireUser, async (req, res) => {
router.get("/:config_id", async (req, res) => {
  const { config_id } = req.params;

  const sql = `
    SELECT
      config_id::text,
      label_name,
      label_id,
      customer,
      plant,
      company_code,
      sales_organization,
      warehouse,
      shipping_point,
      process_type,
      number_of_labels,
      priority,
      active,
      to_char(valid_from, 'YYYY-MM-DD') as valid_from,
      to_char(valid_to, 'YYYY-MM-DD') as valid_to,
      printer,
      output_conditions,
      encrypted_payload,
      ${AUDIT_SELECT_SQL}
    FROM label_configs
    WHERE config_id = $1::uuid
    LIMIT 1;
  `;
  const result = await pool.query(sql, [config_id]);
  if (!result.rows[0]) return res.status(404).json({ detail: "Configuration not found" });

  let decryptedPayload: any = null;
  if (result.rows[0].encrypted_payload) {
    try {
      decryptedPayload = maybeDecryptPayload(result.rows[0].encrypted_payload) as any;
    } catch (err) {
      console.warn("Failed to decrypt label config payload:", err);
    }
  }

  return res.json({
    config_id: result.rows[0].config_id,
    label_name: decryptedPayload?.label_name ?? result.rows[0].label_name,
    label_id: decryptedPayload?.label_id ?? result.rows[0].label_id,
    customer: decryptedPayload?.customer ?? result.rows[0].customer,
    plant: decryptedPayload?.plant ?? result.rows[0].plant,
    company_code: decryptedPayload?.company_code ?? result.rows[0].company_code,
    sales_organization: decryptedPayload?.sales_organization ?? result.rows[0].sales_organization,
    warehouse: decryptedPayload?.warehouse ?? result.rows[0].warehouse,
    shipping_point: decryptedPayload?.shipping_point ?? result.rows[0].shipping_point,
    process_type: decryptedPayload?.process_type ?? result.rows[0].process_type,
    number_of_labels: decryptedPayload?.number_of_labels ?? result.rows[0].number_of_labels,
    priority: decryptedPayload?.priority ?? result.rows[0].priority,
    active: decryptedPayload?.active ?? result.rows[0].active,
    valid_from: decryptedPayload?.valid_from ?? result.rows[0].valid_from,
    valid_to: decryptedPayload?.valid_to ?? result.rows[0].valid_to,
    printer: decryptedPayload?.printer ?? result.rows[0].printer,
    output_conditions: result.rows[0].output_conditions ?? decryptedPayload?.output_conditions ?? {},
    created_by: result.rows[0].created_by,
    created_on: result.rows[0].created_on,
    updated_by: result.rows[0].updated_by,
    updated_on: result.rows[0].updated_on,
  });
});

/**
 * PUT /api/label-configs/:config_id
 * configurator only
 */
// router.put("/:config_id", requireUser, requireConfigurator, async (req: AuthedRequest, res) => {
router.put("/:config_id", async (req: AuthedRequest, res) => {
  const { config_id } = req.params;

  const parsed = labelConfigUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.flatten() });

  const body = parsed.data;
  const nowUser = auditActor(req, "Unknown");

  // STEP 7: reference validation for fields being updated
  try {
    await validateRefsForUpdate(body);
  } catch (e: any) {
    return res.status(e.statusCode || 400).json({ detail: e.message || "Invalid reference" });
  }

  const existingResult = await pool.query(
    `SELECT
      label_name,
      label_id,
      customer,
      plant,
      company_code,
      sales_organization,
      warehouse,
      shipping_point,
      process_type,
      number_of_labels,
      priority,
      active,
      to_char(valid_from, 'YYYY-MM-DD') as valid_from,
      to_char(valid_to, 'YYYY-MM-DD') as valid_to,
      printer,
      output_conditions,
      encrypted_payload
     FROM label_configs
     WHERE config_id = $1::uuid
     LIMIT 1`,
    [config_id]
  );

  if (!existingResult.rows[0]) {
    return res.status(404).json({ detail: "Configuration not found" });
  }

  let existingData: any = {
    ...existingResult.rows[0],
  };
  if (existingData.encrypted_payload) {
    try {
      existingData = {
        ...existingData,
        ...(maybeDecryptPayload(existingData.encrypted_payload) as any),
      };
    } catch (err) {
      console.warn("Failed to decrypt existing label config payload:", err);
    }
  }

  const updatedPayload = buildEncryptedPayload({
    label_name: body.label_name ?? existingData.label_name,
    label_id: body.label_id ?? existingData.label_id,
    customer: body.customer !== undefined ? body.customer : existingData.customer,
    plant: body.plant !== undefined ? body.plant : existingData.plant,
    company_code: body.company_code !== undefined ? body.company_code : existingData.company_code,
    sales_organization: body.sales_organization !== undefined ? body.sales_organization : existingData.sales_organization,
    warehouse: body.warehouse !== undefined ? body.warehouse : existingData.warehouse,
    shipping_point: body.shipping_point !== undefined ? body.shipping_point : existingData.shipping_point,
    process_type: body.process_type !== undefined ? body.process_type : existingData.process_type,
    number_of_labels: body.number_of_labels ?? existingData.number_of_labels,
    priority: body.priority ?? existingData.priority,
    active: body.active ?? existingData.active,
    valid_from: body.valid_from ?? existingData.valid_from,
    valid_to: body.valid_to ?? existingData.valid_to,
    printer: body.printer ?? existingData.printer,
    created_by: existingData.created_by ?? nowUser,
    updated_by: nowUser,
  });

  // Build dynamic update query similar to Mongo $set
  const setParts: string[] = [];
  const values: any[] = [];
  let i = 1;

  const setField = (col: string, val: any, cast?: string) => {
    if (val === undefined) return;
    if (cast) setParts.push(`${col} = $${i++}::${cast}`);
    else setParts.push(`${col} = $${i++}`);
    values.push(val);
  };

  setField("label_name", body.label_name);
  setField("label_id", body.label_id);
  setField("customer", body.customer ?? null);
  setField("plant", body.plant ?? null);
  setField("company_code", body.company_code ?? null);
  setField("sales_organization", body.sales_organization ?? null);
  setField("warehouse", body.warehouse ?? null);
  setField("shipping_point", body.shipping_point ?? null);
  setField("process_type", body.process_type ?? null);
  setField("number_of_labels", body.number_of_labels);
  setField("priority", body.priority);
  setField("active", body.active);
  setField("valid_from", body.valid_from ?? null, "date");
  setField("valid_to", body.valid_to ?? null, "date");
  setField("printer", body.printer ?? null);
  if (body.output_conditions !== undefined) {
    setParts.push(`output_conditions = $${i++}::jsonb`);
    values.push(JSON.stringify(body.output_conditions ?? {}));
  }

  setParts.push(`encrypted_payload = $${i++}`);
  values.push(updatedPayload);
  setParts.push(`updated_by = $${i++}`);
  values.push(nowUser);
  setParts.push(`updated_on = NOW()`);

  if (setParts.length === 0) {
    return res.status(400).json({ detail: "No fields provided to update" });
  }

  values.push(config_id);

  const sql = `
    UPDATE label_configs
    SET ${setParts.join(", ")}
    WHERE config_id = $${i}::uuid
    RETURNING
      config_id::text,
      label_name,
      label_id,
      customer,
      plant,
      company_code,
      sales_organization,
      warehouse,
      shipping_point,
      process_type,
      number_of_labels,
      priority,
      active,
      to_char(valid_from, 'YYYY-MM-DD') as valid_from,
      to_char(valid_to, 'YYYY-MM-DD') as valid_to,
      printer,
      ${AUDIT_SELECT_SQL};
  `;

  const result = await pool.query(sql, values);
  if (!result.rows[0]) return res.status(404).json({ detail: "Configuration not found" });

  return res.json(result.rows[0]);
});

/**
 * DELETE /api/label-configs/:config_id
 * configurator only
 */
// router.delete("/:config_id", requireUser, requireConfigurator, async (req, res) => {
router.delete("/:config_id", async (req, res) => {
  const { config_id } = req.params;

  const result = await pool.query(
    `DELETE FROM label_configs WHERE config_id = $1::uuid`,
    [config_id]
  );

  if (result.rowCount === 0) return res.status(404).json({ detail: "Configuration not found" });
  return res.json({ message: "Configuration deleted successfully" });
});

export default router;
