import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";

const router = Router();

const determinationSchema = z.object({
  customer: z.string().optional().nullable(),
  plant: z.string().optional().nullable(),
  company_code: z.string().optional().nullable(),
  sales_organization: z.string().optional().nullable(),
  warehouse: z.string().optional().nullable(),
  shipping_point: z.string().optional().nullable(),
  process_type: z.string().optional().nullable(),
});

/**
 * POST /api/label-determination
 * Returns:
 * { labels: [{label_name,label_id,number_of_labels,priority}], match_count }
 */
router.post("/", async (req, res) => {
  const parsed = determinationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.flatten() });

  const input = parsed.data;

  // Normalize undefined -> null to simplify SQL comparisons
  const customer = input.customer ?? null;
  const plant = input.plant ?? null;
  const companyCode = input.company_code ?? null;
  const salesOrg = input.sales_organization ?? null;
  const warehouse = input.warehouse ?? null;
  const shippingPoint = input.shipping_point ?? null;
  const processType = input.process_type ?? null;

  /**
   * Matching rules in SQL:
   * For each field:
   *   - If DB has a value, input must exist AND match => (db.field IS NULL OR db.field = $input) AND NOT (db.field IS NOT NULL AND $input IS NULL)
   *
   * The second condition ensures: if db has value but input is missing => reject
   *
   * Exact match count:
   *   sum of CASE WHEN db.field IS NOT NULL AND db.field = $input THEN 1 ELSE 0 END
   */
  const sql = `
    SELECT
      label_name,
      label_id,
      number_of_labels,
      priority,
      (
        CASE WHEN customer IS NOT NULL AND customer = $1 THEN 1 ELSE 0 END +
        CASE WHEN plant IS NOT NULL AND plant = $2 THEN 1 ELSE 0 END +
        CASE WHEN company_code IS NOT NULL AND company_code = $3 THEN 1 ELSE 0 END +
        CASE WHEN sales_organization IS NOT NULL AND sales_organization = $4 THEN 1 ELSE 0 END +
        CASE WHEN warehouse IS NOT NULL AND warehouse = $5 THEN 1 ELSE 0 END +
        CASE WHEN shipping_point IS NOT NULL AND shipping_point = $6 THEN 1 ELSE 0 END +
        CASE WHEN process_type IS NOT NULL AND process_type = $7 THEN 1 ELSE 0 END
      ) AS exact_matches
    FROM label_configs
    WHERE active = true

      -- customer match logic
      AND (customer IS NULL OR customer = $1)
      AND NOT (customer IS NOT NULL AND $1 IS NULL)

      -- plant
      AND (plant IS NULL OR plant = $2)
      AND NOT (plant IS NOT NULL AND $2 IS NULL)

      -- company_code
      AND (company_code IS NULL OR company_code = $3)
      AND NOT (company_code IS NOT NULL AND $3 IS NULL)

      -- sales_organization
      AND (sales_organization IS NULL OR sales_organization = $4)
      AND NOT (sales_organization IS NOT NULL AND $4 IS NULL)

      -- warehouse
      AND (warehouse IS NULL OR warehouse = $5)
      AND NOT (warehouse IS NOT NULL AND $5 IS NULL)

      -- shipping_point
      AND (shipping_point IS NULL OR shipping_point = $6)
      AND NOT (shipping_point IS NOT NULL AND $6 IS NULL)

      -- process_type
      AND (process_type IS NULL OR process_type = $7)
      AND NOT (process_type IS NOT NULL AND $7 IS NULL)

    ORDER BY exact_matches DESC, priority ASC
    LIMIT 1000;
  `;

  const values = [customer, plant, companyCode, salesOrg, warehouse, shippingPoint, processType];
  const result = await pool.query(sql, values);

  const labels = result.rows.map((r) => ({
    label_name: r.label_name,
    label_id: r.label_id,
    number_of_labels: r.number_of_labels,
    priority: r.priority,
  }));

  return res.json({ labels, match_count: labels.length });
});

export default router;