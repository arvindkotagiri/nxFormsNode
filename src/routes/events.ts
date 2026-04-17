// import { Router } from "express";
// import { pool } from "../db";
// import { v4 as uuidv4 } from "uuid";
// import { processOutputDetermination } from "../workers/outputWorker";
// import { requireUser } from "../middleware/auth";

// const router = Router();

// /**
//  * GET /api/events
//  * Returns latest events
//  */
// router.get("/", async (req, res) => {
//   try {
//     const result = await pool.query(`
//       SELECT 
//         event_id,
//         source,
//         context,
//         form,
//         status,
//         event_timestamp,
//         duration_ms,
//         outputs
//       FROM events
//       ORDER BY event_timestamp DESC
//       LIMIT 100
//     `);

//     const formatted = result.rows.map((r) => ({
//       id: r.event_id,
//       source: r.source,
//       context: r.context,
//       form: r.form,
//       status: r.status,
//       ts: r.event_timestamp,
//       duration: r.duration_ms ? `${r.duration_ms}ms` : "–",
//       outputs: r.outputs,
//     }));

//     res.json(formatted);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Failed to fetch events" });
//   }
// });
 
// router.post("/trigger", requireUser, async (req, res) => {
//   const { context, entity_key, event_type, triggered_by, source_system, form } = req.body;

//   if (!context || !entity_key || !event_type || !triggered_by || !source_system) {
//     return res.status(400).json({ 
//       error: "Missing mandatory fields: context, entity_key, event_type, triggered_by, source_system" 
//     });
//   }

//   // Generate standard v4 UUID
//   const eventId = uuidv4();

//   try {
//     // Insert into your 'events' table
//     await pool.query(
//       `INSERT INTO events 
//         (event_id, source, context, entity_key, event_type, triggered_by, form, status, event_timestamp, outputs) 
//        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', NOW(), 0)`,
//       [eventId, source_system, context, entity_key, event_type, triggered_by, form]
//     );

//     // Trigger API 2 asynchronously 
//     processOutputDetermination(eventId).catch(err => {
//       console.error(`Background worker failed for ${eventId}:`, err);
//     });

//     res.status(202).json({
//       event_id: eventId,
//       status: "Accepted"
//     });

//   } catch (err) {
//     console.error("Trigger insert failed:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

// export default router;

import { Router } from "express";
import { pool } from "../db";
import { v4 as uuidv4 } from "uuid";
import { processOutputDetermination } from "../workers/outputWorker";
import { requireUser } from "../middleware/auth";

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
 
router.post("/trigger", requireUser, async (req, res) => {
  const { context, entity_key, event_type, triggered_by, source_system, form, data } = req.body;

  if (!context || !entity_key || !event_type || !triggered_by || !source_system || !form) {
    return res.status(400).json({ 
      error: "Missing mandatory fields: context, entity_key, event_type, triggered_by, source_system, form" 
    });
  }

  // ✅ FIX #1: Validate that data is provided
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ 
      error: "Missing or invalid data object" 
    });
  }

  const eventId = uuidv4();

  try {
    // ✅ FIX #2: Store the data payload as payload
    await pool.query(
      `INSERT INTO events 
        (event_id, source, context, entity_key, event_type, triggered_by, form, payload, status, event_timestamp, outputs) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', NOW(), 0)`,
      [eventId, source_system, context, entity_key, event_type, triggered_by, form, JSON.stringify(data)]
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

router.get("/:eventId/output", requireUser, async (req, res) => {
  const { eventId } = req.params;

  try {
    const result = await pool.query(
      `SELECT 
         o.output_id,
         o.status,
         o.format,
         o.document_json,
         o.rendered_output,
         o.error_message,
         o.completed_at,
         e.status as event_status,
         e.error_message as event_error
       FROM events e
       LEFT JOIN outputs o ON o.event_id = e.event_id
       WHERE e.event_id = $1
       ORDER BY o.created_at ASC`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }

    const eventStatus = result.rows[0].event_status;
    const eventError = result.rows[0].event_error;

    const outputs = result.rows
      .filter((r) => r.output_id)
      .map((r) => ({
        output_id: r.output_id,
        status: r.status,
        format: r.format,
        document_json: r.document_json,
        rendered_output: r.rendered_output,   // ✅ included
        error_message: r.error_message,
        completed_at: r.completed_at,
      }));

    res.json({
      event_id: eventId,
      event_status: eventStatus,
      event_error: eventError,
      outputs,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch event output" });
  }
});


export default router;