// // workers/outputWorker.ts
// // API2 — Output Determination Engine
// //
// // Matches the incoming event's document data against label_configs
// // using the same field-matching logic as determination.ts.
// // Creates one output row per matched label_config rule.

// import { pool } from "../db";
// import { v4 as uuidv4 } from "uuid";
// import { processOutputAgent } from "./printWorker";

// // ── Document data fetch (STUBBED) ──────────────────────────────────────────────
// // The document data contains the org fields (customer, plant, etc.) used to
// // match against label_configs. Replace this stub with your real S4HANA /
// // mobile API call when ready.
// //
// // The returned object should contain fields matching label_configs columns:
// //   customer, plant, company_code, sales_organization,
// //   warehouse, shipping_point, process_type

// async function fetchDocumentData(
//   entityKey: string,
//   context: string
// ): Promise<Record<string, string | null>> {
//   // ── STUB ───────────────────────────────────────────────────────────────────
//   console.warn(
//     `[API2] STUB: fetchDocumentData called for entity_key=${entityKey} context=${context}. ` +
//     `Returning mock org fields. Replace with real API call when ready.`
//   );
//   return {
//     customer: "C001",
//     plant: "P001",
//     company_code: null,
//     sales_organization: null,
//     warehouse: null,
//     shipping_point: null,
//     process_type: null,
//   };
//   // ── END STUB ───────────────────────────────────────────────────────────────

//   // Uncomment when real endpoint is available:
//   // const url = `https://your-source-api/data/${context}/${entityKey}`;
//   // const response = await fetch(url, { /* auth headers */ });
//   // if (!response.ok) throw new Error(`Source API returned ${response.status}`);
//   // return response.json();
// }

// // ── Main worker ────────────────────────────────────────────────────────────────

// export async function processOutputDetermination(eventId: string): Promise<void> {
//   const startTime = Date.now();

//   // ── 1. Read event ────────────────────────────────────────────────────────────
//   const eventResult = await pool.query(
//     `SELECT * FROM events WHERE event_id = $1`,
//     [eventId]
//   );
//   const event = eventResult.rows[0];

//   if (!event) {
//     console.error(`[API2] Event ${eventId} not found — aborting`);
//     return;
//   }

//   // ── 2. Duplicate / race guard ─────────────────────────────────────────────
//   if (event.status !== "Pending") {
//     console.info(`[API2] Event ${eventId} already "${event.status}" — skipping`);
//     return;
//   }

//   const claimed = await pool.query(
//     `UPDATE events SET status = 'Processing'
//      WHERE event_id = $1 AND status = 'Pending'
//      RETURNING event_id`,
//     [eventId]
//   );
//   if (claimed.rowCount === 0) {
//     console.info(`[API2] Event ${eventId} claimed by another worker — skipping`);
//     return;
//   }

//   try {
//     const { context, entity_key } = event;

//     // ── 3. Fetch document data from source system ────────────────────────────
//     // Gives us the org fields (customer, plant, etc.) to run determination.
//     const docData = await fetchDocumentData(entity_key, context);

//     const {
//       customer = null,
//       plant = null,
//       company_code = null,
//       sales_organization = null,
//       warehouse = null,
//       shipping_point = null,
//       process_type = null,
//     } = docData;

//     // ── 4. Run determination against label_configs ────────────────────────────
//     // Same matching logic as determination.ts:
//     //   - Config row with a value → document must match it
//     //   - Config row with NULL    → wildcard, matches anything
//     //   - More exact matches rank higher, then sorted by priority ASC
//     //   - valid_from / valid_to respected so only current rules fire
//     const configResult = await pool.query(
//       `SELECT
//          label_id,
//          label_name,
//          priority,
//          (
//            CASE WHEN customer           IS NOT NULL AND customer           = $1 THEN 1 ELSE 0 END +
//            CASE WHEN plant              IS NOT NULL AND plant              = $2 THEN 1 ELSE 0 END +
//            CASE WHEN company_code       IS NOT NULL AND company_code       = $3 THEN 1 ELSE 0 END +
//            CASE WHEN sales_organization IS NOT NULL AND sales_organization = $4 THEN 1 ELSE 0 END +
//            CASE WHEN warehouse          IS NOT NULL AND warehouse          = $5 THEN 1 ELSE 0 END +
//            CASE WHEN shipping_point     IS NOT NULL AND shipping_point     = $6 THEN 1 ELSE 0 END +
//            CASE WHEN process_type       IS NOT NULL AND process_type       = $7 THEN 1 ELSE 0 END
//          ) AS exact_matches
//        FROM label_configs
//        WHERE active = true
//          AND (valid_from IS NULL OR valid_from <= NOW())
//          AND (valid_to   IS NULL OR valid_to   >= NOW())

//          AND (customer           IS NULL OR customer           = $1)
//          AND NOT (customer           IS NOT NULL AND $1 IS NULL)

//          AND (plant              IS NULL OR plant              = $2)
//          AND NOT (plant              IS NOT NULL AND $2 IS NULL)

//          AND (company_code       IS NULL OR company_code       = $3)
//          AND NOT (company_code       IS NOT NULL AND $3 IS NULL)

//          AND (sales_organization IS NULL OR sales_organization = $4)
//          AND NOT (sales_organization IS NOT NULL AND $4 IS NULL)

//          AND (warehouse          IS NULL OR warehouse          = $5)
//          AND NOT (warehouse          IS NOT NULL AND $5 IS NULL)

//          AND (shipping_point     IS NULL OR shipping_point     = $6)
//          AND NOT (shipping_point     IS NOT NULL AND $6 IS NULL)

//          AND (process_type       IS NULL OR process_type       = $7)
//          AND NOT (process_type       IS NOT NULL AND $7 IS NULL)

//        ORDER BY exact_matches DESC, priority ASC`,
//       [customer, plant, company_code, sales_organization, warehouse, shipping_point, process_type]
//     );

//     const matchedConfigs = configResult.rows;

//     if (matchedConfigs.length === 0) {
//       await finalizeEvent(
//         eventId, "Failed",
//         `No matching label_configs for context="${context}" with the provided org fields`,
//         startTime, 0, null
//       );
//       return;
//     }

//     // ── 5. Insert one output row per matched config ───────────────────────────
//     let outputsCreated = 0;
//     let lastLabelId: string | null = null;
//     const agentPromises: Promise<void>[] = [];
//     const outputIds: string[] = [];

//     for (const cfg of matchedConfigs) {
//       console.log(cfg);
//       // const outputId = uuidv4();

//       // await pool.query(
//       //   `INSERT INTO outputs
//       //      (output_id, event_id, form_id, printer, status, retries, created_at, document_json)
//       //    VALUES ($1, $2, $3, $4, 'Pending', 0, NOW(), $5)`,
//       //   [
//       //     outputId,
//       //     eventId,
//       //     cfg.label_id,
//       //     cfg.printer ?? "PDF-EXPORT",
//       //     JSON.stringify(docData),
//       //   ]
//       // );

//       const formResult = await pool.query(
//         `SELECT output_mode FROM label_master WHERE output_mode = $1 ORDER BY version DESC LIMIT 1`,
//         [event.form]
//       );

//       const outputMode = formResult.rows[0]?.output_mode ?? "html";

//       const formats =
//         outputMode === "both"
//           ? ["PDF", "ZPL"]
//           : [outputMode.toUpperCase()];

//       for (const format of formats) {
//         const outputId = uuidv4();

//         await pool.query(
//           `INSERT INTO outputs
//       (output_id, event_id, form_id, printer, format, status, retries, created_at, document_json)
//      VALUES ($1, $2, $3, $4, $5, 'Pending', 0, NOW(), $6)`,
//           [
//             outputId,
//             eventId,
//             event.form,
//             cfg.printer ?? "PDF-EXPORT",
//             format,
//             JSON.stringify(docData),
//           ]
//         );

//         outputsCreated++;
//       lastLabelId = cfg.label_id;
//       console.info(
//         `[API2] Output created: output_id=${outputId} label=${cfg.label_id}`
//       );

//       outputIds.push(outputId);
//       }
//     }

//     // Fire API3
//     for (const id of outputIds) {
//   processOutputAgent(id).catch((err) => {
//     console.error(`[API2] API3 agent failed for output ${id}:`, err);
//   });
// }
    
//     // Run all API3 agents concurrently without blocking finalization
//     // Promise.allSettled(agentPromises);

//     // ── 6. Finalize event ─────────────────────────────────────────────────────
//     await finalizeEvent(eventId, "Success", null, startTime, outputsCreated, lastLabelId);

//   } catch (err: any) {
//     console.error(`[API2] Worker error for event ${eventId}:`, err.message);
//     await finalizeEvent(eventId, "Failed", err.message, startTime, 0, null);
//   }
// }

// // ── Helper ─────────────────────────────────────────────────────────────────────

// async function finalizeEvent(
//   eventId: string,
//   status: string,
//   errorMessage: string | null,
//   startTime: number,
//   outputsCount: number,
//   formId: string | null
// ): Promise<void> {
//   const durationMs = Date.now() - startTime;
//   if (formId) {
//     await pool.query(
//       `UPDATE events
//        SET status = $1, error_message = $2, duration_ms = $3, outputs = $4, form = $5
//        WHERE event_id = $6`,
//       [status, errorMessage, durationMs, outputsCount, formId, eventId]
//     );
//   } else {
//     await pool.query(
//       `UPDATE events
//        SET status = $1, error_message = $2, duration_ms = $3, outputs = $4
//        WHERE event_id = $5`,
//       [status, errorMessage, durationMs, outputsCount, eventId]
//     );
//   }
// }


// workers/outputWorker.ts
// API2 — Output Determination Engine
//
// Matches the incoming event's document data against label_configs
// using the same field-matching logic as determination.ts.
// Creates one output row per matched label_config rule.

import { pool } from "../db";
import { v4 as uuidv4 } from "uuid";
import { processOutputAgent } from "./printWorker";

// ── Main worker ────────────────────────────────────────────────────────────────

export async function processOutputDetermination(eventId: string): Promise<void> {
  const startTime = Date.now();

  // ── 1. Read event ────────────────────────────────────────────────────────────
  const eventResult = await pool.query(
    `SELECT * FROM events WHERE event_id = $1`,
    [eventId]
  );
  const event = eventResult.rows[0];

  if (!event) {
    console.error(`[API2] Event ${eventId} not found — aborting`);
    return;
  }

  // ── 2. Duplicate / race guard ─────────────────────────────────────────────
  if (event.status !== "Pending") {
    console.info(`[API2] Event ${eventId} already "${event.status}" — skipping`);
    return;
  }

  const claimed = await pool.query(
    `UPDATE events SET status = 'Processing'
     WHERE event_id = $1 AND status = 'Pending'
     RETURNING event_id`,
    [eventId]
  );
  if (claimed.rowCount === 0) {
    console.info(`[API2] Event ${eventId} claimed by another worker — skipping`);
    return;
  }

  try {
    const { context, entity_key, form } = event;

    // ✅ FIX #3: Get actual document data from events table instead of stub
    let docData: Record<string, string | null>;
    
    // Try to parse payload if it exists, otherwise use empty object
    if (event.payload) {
      docData = typeof event.payload === 'string' 
        ? JSON.parse(event.payload)
        : event.payload;
    } else {
      // Fallback if no payload (shouldn't happen with fixed events.ts)
      docData = {};
    }

    console.log(`[API2] Event ${eventId} document data:`, docData);

    // ── 3. For now, skip label_config matching and create output directly ──────
    // (Simplified flow - if you need label_config matching later, add it back)
    
    const formResult = await pool.query(
      `SELECT output_mode FROM label_master WHERE label_name = $1 ORDER BY version DESC LIMIT 1`,
      [form]
    );

    console.log(`[API2] Fetched form config for "${form}":`, formResult.rows[0]);

    if (formResult.rowCount === 0) {
      await finalizeEvent(
        eventId, 
        "Failed",
        `No template found for form="${form}"`,
        startTime, 
        0, 
        null
      );
      return;
    }

    const outputMode = formResult.rows[0]?.output_mode ?? "html";
    const formats =
      outputMode === "both"
        ? ["PDF", "ZPL"]
        : [outputMode.toUpperCase()];

    // ── 4. Create output rows ──────────────────────────────────────────────────
    let outputsCreated = 0;
    const outputIds: string[] = [];

    for (const format of formats) {
      const outputId = uuidv4();

      await pool.query(
        `INSERT INTO outputs
        (output_id, event_id, form_id, printer, format, status, retries, created_at, document_json)
       VALUES ($1, $2, $3, $4, $5, 'Pending', 0, NOW(), $6)`,
        [
          outputId,
          eventId,
          form,
          "PDF-EXPORT", // Default printer, can be overridden by label_config
          format,
          JSON.stringify(docData), // ✅ Pass actual data to outputs
        ]
      );

      outputsCreated++;
      console.info(
        `[API2] Output created: output_id=${outputId} form=${form} format=${format}`
      );

      outputIds.push(outputId);
    }

    // ── 5. Fire API3 agents (non-blocking) ──────────────────────────────────
    for (const id of outputIds) {
      processOutputAgent(id).catch((err) => {
        console.error(`[API2] API3 agent failed for output ${id}:`, err);
      });
    }

    // ── 6. Finalize event ─────────────────────────────────────────────────────
    await finalizeEvent(eventId, "Success", null, startTime, outputsCreated, form);

  } catch (err: any) {
    console.error(`[API2] Worker error for event ${eventId}:`, err.message);
    await finalizeEvent(eventId, "Failed", err.message, startTime, 0, null);
  }
}

// ── Helper ─────────────────────────────────────────────────────────────────────

async function finalizeEvent(
  eventId: string,
  status: string,
  errorMessage: string | null,
  startTime: number,
  outputsCount: number,
  formId: string | null
): Promise<void> {
  const durationMs = Date.now() - startTime;
  if (formId) {
    await pool.query(
      `UPDATE events
       SET status = $1, error_message = $2, duration_ms = $3, outputs = $4, form = $5
       WHERE event_id = $6`,
      [status, errorMessage, durationMs, outputsCount, formId, eventId]
    );
  } else {
    await pool.query(
      `UPDATE events
       SET status = $1, error_message = $2, duration_ms = $3, outputs = $4
       WHERE event_id = $5`,
      [status, errorMessage, durationMs, outputsCount, eventId]
    );
  }
}