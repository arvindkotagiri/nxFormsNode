import { Router } from "express";
import { pool } from "../db";
import { v4 as uuidv4 } from "uuid";
import { processOutputDetermination } from "../workers/outputWorker";

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

router.post("/trigger", async (req, res) => {
  const { context, entity_key, event_type, triggered_by, source_system, form } = req.body;

  if (!context || !entity_key || !event_type || !triggered_by || !source_system) {
    return res.status(400).json({ 
      error: "Missing mandatory fields: context, entity_key, event_type, triggered_by, source_system" 
    });
  }

  // Generate standard v4 UUID
  const eventId = uuidv4();

  try {
    // Insert into your 'events' table
    await pool.query(
      `INSERT INTO events 
        (event_id, source, context, entity_key, event_type, triggered_by, form, status, event_timestamp, outputs) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', NOW(), 0)`,
      [eventId, source_system, context, entity_key, event_type, triggered_by, form]
    );

    // Trigger API 2 asynchronously 
    processOutputDetermination(eventId).catch(err => {
      console.error(`Background worker failed for ${eventId}:`, err);
    });

    res.status(202).json({
      event_id: eventId,
      status: "Accepted"
    });

  } catch (err) {
    console.error("Trigger insert failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;