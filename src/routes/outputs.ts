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
        o.output_id,
        e.event_number,
        o.form_id,
        o.printer,
        o.format,
        o.status,
        o.retries,
        o.duration,
        o.error_message,
        o.rendered_output,
        o.output_number
      FROM outputs o
      JOIN events e ON o.event_id = e.event_id  -- join on the primary/foreign key
      ORDER BY o.output_id DESC
    `);

    const formatted = result.rows.map((r) => ({
      id: r.output_id,
      eventId: r.event_id,
      evt_no: r.event_number,
      formId: r.form_id,
      printer: r.printer,
      format: r.format,
      status: r.status,
      retries: r.retries,
      duration: r.duration ? `${r.duration}ms` : "–",
      errorMessage: r.error_message,
      renderedOutput: r.rendered_output,
      outputNumber: r.output_number,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch outputs" });
  }
});

export default router;