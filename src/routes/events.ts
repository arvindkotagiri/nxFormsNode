import { Router } from "express";
import { pool } from "../db";
import { v4 as uuidv4 } from "uuid";
import { processOutputDetermination, newprocessOutputDetermination } from "../workers/outputWorker";
import { requireUser } from "../middleware/auth";
import archiver from "archiver";
import { htmlToPdf } from "../workers/printWorker";
import { AUDIT_SELECT_SQL, auditSelectSql } from "../utils/audit";
import { buildEncryptedPayload, maybeDecryptPayload } from "../utils/dataEncryption";

const router = Router();

/**
 * GET /api/events
 * Returns latest events
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        event_number,
        event_id,
        source,
        context,
        form,
        status,
        event_timestamp,
        duration_ms,
        outputs,
        triggered_by,
        encrypted_payload,
        ${AUDIT_SELECT_SQL}
      FROM events
      ORDER BY event_timestamp DESC
    `);

    const formatted = result.rows.map((r) => {
      let decryptedPayload: any = null;
      if (r.encrypted_payload) {
        try {
          decryptedPayload = maybeDecryptPayload(r.encrypted_payload) as any;
        } catch (err) {
          console.warn("Failed to decrypt event payload:", err);
        }
      }
      return {
        id: r.event_id,
        evt_no: r.event_number,
        source: decryptedPayload?.source ?? r.source,
        context: decryptedPayload?.context ?? r.context,
        form: decryptedPayload?.form ?? r.form,
        status: decryptedPayload?.status ?? r.status,
        ts: decryptedPayload?.event_timestamp ?? r.event_timestamp,
        duration: r.duration_ms ? `${r.duration_ms}ms` : "–",
        outputs: decryptedPayload?.outputs ?? r.outputs,
        created_by: r.triggered_by,
        created_on: r.created_on,
        updated_by: r.updated_by,
        updated_on: r.updated_on,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// router.post("/trigger", requireUser, async (req, res) => {
//   const { context, entity_key, event_type, triggered_by, source_system, form, data } = req.body;

//   if (!context || !entity_key || !event_type || !triggered_by || !source_system || !form) {
//     return res.status(400).json({ 
//       error: "Missing mandatory fields: context, entity_key, event_type, triggered_by, source_system, form" 
//     });
//   }

//   // ✅ FIX #1: Validate that data is provided
//   if (!data || typeof data !== 'object') {
//     return res.status(400).json({ 
//       error: "Missing or invalid data object" 
//     });
//   }

//   const eventId = uuidv4();

//   try {
//     // ✅ FIX #2: Store the data payload as payload
//     await pool.query(
//       `INSERT INTO events 
//         (event_id, source, context, entity_key, event_type, triggered_by, form, payload, status, event_timestamp, outputs) 
//        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', NOW(), 0)`,
//       [eventId, source_system, context, entity_key, event_type, triggered_by, form, JSON.stringify(data)]
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

router.post("/trigger", async (req, res) => {
  const props = req.body;
  const { context, entity_key, event_type, triggered_by, source_system, print_to_file, simulate = false, form_id = ''} = req.body;
  if (!context || !entity_key || !event_type || !triggered_by || !source_system || !print_to_file) {
    return res.status(400).json({ 
      error: "Missing mandatory fields: context, entity_key, event_type, triggered_by, source_system, print_to_file" 
    });
  }

  const eventId = uuidv4();

  try {
    // ✅ FIX #2: Store the data payload as payload
    const encryptedPayload = buildEncryptedPayload({
      event_id: eventId,
      source: source_system,
      context,
      entity_key,
      event_type,
      triggered_by,
      print_to_file,
      status: 'Pending',
      event_timestamp: new Date().toISOString(),
      outputs: 0,
      created_by: triggered_by,
      updated_by: triggered_by,
    });

    await pool.query(
      `INSERT INTO events 
        (event_id, source, context, entity_key, event_type, triggered_by, print_to_file, status, event_timestamp, outputs,
         created_by, created_on, updated_by, updated_on, encrypted_payload) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', NOW(), 0, $6, NOW(), $6, NOW(), $8)`,
      [eventId, source_system, context, entity_key, event_type, triggered_by, print_to_file, encryptedPayload]
    );

    // Trigger API 2 asynchronously 
    newprocessOutputDetermination(eventId, simulate, props).catch(err => {
      console.error(`Background worker failed for ${eventId}:`, err);
    });

    res.status(202).json({
      event_id: eventId,
      status: "Accepted"
    });

  } catch (err) {
    console.error("Trigger insert failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }}
);

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
         o.encrypted_payload as output_encrypted_payload,
         o.error_message,
         o.completed_at,
         ${auditSelectSql("o")},
         e.status as event_status,
         e.encrypted_payload as event_encrypted_payload,
         e.error_message as event_error,
         e.created_by as event_created_by,
         e.created_on::text as event_created_on,
         e.updated_by as event_updated_by,
         e.updated_on::text as event_updated_on
       FROM events e
       LEFT JOIN outputs o ON o.event_id = e.event_id
       WHERE e.event_id = $1
       ORDER BY o.created_on ASC`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Event not found" });
    }

    let eventStatus = result.rows[0].event_status;
    let eventError = result.rows[0].event_error;

    if (result.rows[0].event_encrypted_payload) {
      try {
        const decryptedEvent = maybeDecryptPayload(result.rows[0].event_encrypted_payload) as any;
        eventStatus = decryptedEvent?.status ?? eventStatus;
        eventError = decryptedEvent?.error_message ?? eventError;
      } catch (err) {
        console.warn(`Failed to decrypt event payload for ${eventId}:`, err);
      }
    }

    const outputs = result.rows
      .filter((r) => r.output_id)
      .map((r) => {
        let rendered_output = r.rendered_output;
        if (r.output_encrypted_payload) {
          try {
            const decrypted = maybeDecryptPayload(r.output_encrypted_payload) as any;
            rendered_output = decrypted?.rendered_output ?? rendered_output;
          } catch (err) {
            console.warn(`Failed to decrypt output payload for ${r.output_id}:`, err);
          }
        }

        return {
          output_id: r.output_id,
          status: r.status,
          format: r.format,
          document_json: r.document_json,
          rendered_output,
          error_message: r.error_message,
          completed_at: r.completed_at,
          created_by: r.created_by,
          created_on: r.created_on,
          updated_by: r.updated_by,
          updated_on: r.updated_on,
        };
      });

    res.json({
      event_id: eventId,
      event_status: eventStatus,
      event_error: eventError,
      created_by: result.rows[0].event_created_by,
      created_on: result.rows[0].event_created_on,
      updated_by: result.rows[0].event_updated_by,
      updated_on: result.rows[0].event_updated_on,
      outputs,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch event output" });
  }
});

/**
 * GET /api/events/:eventId/status
 * Lightweight poll endpoint — returns event status + output count
 */
router.get("/:eventId/status", requireUser, async (req, res) => {
  const { eventId } = req.params;

  try {
    const result = await pool.query(
      `SELECT e.status, e.outputs,
              COUNT(o.output_id) FILTER (WHERE o.status = 'Success') AS completed_outputs
       FROM events e
       LEFT JOIN outputs o ON o.event_id = e.event_id
       WHERE e.event_id = $1
       GROUP BY e.status, e.outputs`,
      [eventId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Event not found" });
    }

    const { status, outputs, completed_outputs } = result.rows[0];

    res.json({
      status,
      outputs: Number(outputs),
      completed_outputs: Number(completed_outputs),
      // All outputs done when completed matches total
      all_ready: Number(completed_outputs) === Number(outputs) && Number(outputs) > 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch event status" });
  }
});

/**
 * GET /api/events/:eventId/download
 * Zips all completed outputs for the event and streams to client
 */
router.get("/:eventId/download", requireUser, async (req, res) => {
  const { eventId } = req.params;

  try {
    const result = await pool.query(
      `SELECT output_id, form_id, format, rendered_output, encrypted_payload
       FROM outputs
       WHERE event_id = $1 AND status = 'Success'`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No completed outputs found for this event" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="event-${eventId}-outputs.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    for (const output of result.rows) {
      const { output_id, form_id, format, rendered_output, encrypted_payload } = output;
      const baseName = `${form_id}_${output_id}`;

      let decryptedOutput = rendered_output;
      if (encrypted_payload) {
        try {
          const decrypted = maybeDecryptPayload(encrypted_payload) as any;
          decryptedOutput = decrypted?.rendered_output ?? decryptedOutput;
        } catch (err) {
          console.warn(`Failed to decrypt output ${output_id}:`, err);
        }
      }

      switch (format?.toLowerCase()) {
        case "html": {
          try {
            const pdfBuffer = await htmlToPdf(rendered_output);
            archive.append(pdfBuffer, { name: `${baseName}.pdf` });
          } catch (err) {
            console.error(`[Download] PDF conversion failed for ${output_id}:`, err);
            // Fallback to raw HTML if PDF conversion fails
            archive.append(rendered_output ?? "", { name: `${baseName}.html` });
          }
          break;
        }
        case "zpl": {
          archive.append(rendered_output ?? "", { name: `${baseName}.zpl` });
          break;
        }
        case "xdp": {
          archive.append(rendered_output ?? "", { name: `${baseName}.xdp` });
          break;
        }
        default: {
          archive.append(rendered_output ?? "", { name: `${baseName}.txt` });
          break;
        }
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate download" });
  }
});


export default router;