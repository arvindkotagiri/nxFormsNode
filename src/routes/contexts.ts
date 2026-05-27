import { Router } from "express";
import { pool } from "../db";

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
        fields
      FROM contexts
      ORDER BY name ASC
    `);

    const formatted = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      endpoint: r.endpoint,
      entities: r.entities,
      fields: r.fields,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contexts" });
  }
});

export default router;