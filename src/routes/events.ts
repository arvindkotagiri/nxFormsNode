import { Router } from "express";
import { pool } from "../db";

const router = Router();

/**
 * GET /api/events
 * Returns latest events
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        event_id,
        source,
        context,
        form,
        status,
        event_timestamp,
        duration_ms,
        outputs
      FROM events
      ORDER BY event_timestamp DESC
      LIMIT 100
    `);

    const formatted = result.rows.map((r) => ({
      id: r.event_id,
      source: r.source,
      context: r.context,
      form: r.form,
      status: r.status,
      ts: r.event_timestamp,
      duration: r.duration_ms ? `${r.duration_ms}ms` : "–",
      outputs: r.outputs,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

export default router;