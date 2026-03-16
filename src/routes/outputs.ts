import { Router } from "express";
import { pool } from "../db";

const router = Router();

/**
 * GET /api/outputs
 * Returns latest outputs
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        output_id,
        event_id,
        form_id,
        printer,
        format,
        status,
        retries,
        duration
      FROM outputs
      ORDER BY output_id DESC
      LIMIT 100
    `);

    const formatted = result.rows.map((r) => ({
      id: r.output_id,
      eventId: r.event_id,
      formId: r.form_id,
      printer: r.printer,
      format: r.format,
      status: r.status,
      retries: r.retries,
      duration: r.duration ? `${r.duration}ms` : "–",
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch outputs" });
  }
});

export default router;