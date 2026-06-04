import { Router } from "express";
import { pool } from "../db";
import { AUDIT_SELECT_SQL } from "../utils/audit";

const router = Router();

/**
 * GET /api/contexts
 * Returns all contexts
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        endpoint,
        entities,
        fields,
        ${AUDIT_SELECT_SQL}
      FROM contexts
      ORDER BY name ASC
    `);

    const formatted = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      endpoint: r.endpoint,
      entities: r.entities,
      fields: r.fields,
      created_by: r.created_by,
      created_on: r.created_on,
      updated_by: r.updated_by,
      updated_on: r.updated_on,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contexts" });
  }
});

export default router;
