// workers/printWorker.ts
// API3 — Output Processing Agent
//
// For each output row created by API2:
//   1. Read the output record
//   2. Fetch template from label_master using form_id (= label_master.label_id)
//   3. Transform document_json → HTML or ZPL using field_mapping
//   4. Send to printer (stubbed — uncomment when printer endpoints ready)
//   5. Update output status; increment retry_count on failure

import { pool } from "../db";

const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);

// ── Types ──────────────────────────────────────────────────────────────────────

interface LabelMaster {
  uuid: string;
  label_id: string;
  label_name: string;
  context: string;
  output_mode: string;       // "html" | "zpl"
  html_code: string | null;
  zpl_code: string | null;
  field_mapping: Record<string, string> | null;
  // field_mapping stores { templatePlaceholder: documentJsonField }
  // e.g. { "{{CUSTOMER_NAME}}": "customer", "{{ORDER_NO}}": "entity_key" }
}

// ── Template renderer ──────────────────────────────────────────────────────────

function renderTemplate(template: LabelMaster, docData: Record<string, unknown>): string {
  // Pick the right template string based on output_mode
  const raw = template.output_mode === "zpl"
    ? template.zpl_code ?? ""
    : template.html_code ?? "";

  if (!raw) {
    throw new Error(
      `label_master row for label_id=${template.label_id} has no ` +
      `${template.output_mode === "zpl" ? "zpl_code" : "html_code"}`
    );
  }

  let rendered = raw;

  // If field_mapping exists, use it for precise placeholder → doc field mapping.
  // field_mapping format:  { "{{CUST}}": "customer", "{{PLANT}}": "plant" }
  if (template.field_mapping && Object.keys(template.field_mapping).length > 0) {
    for (const [placeholder, docField] of Object.entries(template.field_mapping)) {
      const value = String(docData[docField] ?? "");
      rendered = rendered.replace(new RegExp(escapeRegex(placeholder), "g"), value);
    }
  } else {
    // Fallback: generic {{key}} substitution directly from docData keys.
    // Works for simple templates where placeholders match JSON field names.
    for (const [key, value] of Object.entries(docData)) {
      rendered = rendered.replace(
        new RegExp(`{{${escapeRegex(key)}}}`, "g"),
        String(value ?? "")
      );
    }
  }

  return rendered;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Main agent ─────────────────────────────────────────────────────────────────

export async function processOutputAgent(outputId: string): Promise<void> {
  const startTime = Date.now();

  try {
    // ── 1. Read output record ────────────────────────────────────────────────
    const outputResult = await pool.query(
      `SELECT * FROM outputs WHERE output_id = $1`,
      [outputId]
    );
    const output = outputResult.rows[0];
    if (!output) throw new Error(`Output record not found: ${outputId}`);

    // ── 2. Fetch template from label_master ───────────────────────────────────
    // label_master.label_id = outputs.form_id  (the link between the two tables)
    console.log("output -> ",output)
    console.log("output.form_id -> ",output.form_id)
    const templateResult = await pool.query(
      `SELECT uuid, label_id, label_name, context,
              output_mode, html_code, zpl_code, field_mapping
       FROM label_master
       WHERE label_name = $1
       ORDER BY version DESC
       LIMIT 1`,
      [output.form_id]
    );
    const template: LabelMaster = templateResult.rows[0];

    if (!template) {
      throw new Error(`No label_master entry found for label_id: ${output.form_id}`);
    }

    // ── 3. Parse document JSON ────────────────────────────────────────────────
    const docData: Record<string, unknown> =
      typeof output.document_json === "string"
        ? JSON.parse(output.document_json)
        : output.document_json;

    // ── 4. Render template (HTML or ZPL) ─────────────────────────────────────
    const finalPayload = renderTemplate(template, docData);

    console.log("finalPayload -> ",finalPayload);
    // ── 5. Send to printer ────────────────────────────────────────────────────
    // TODO: Uncomment and adapt when printer endpoints are configured.
    //
    // For ZPL (raw TCP to port 9100):
    //   const net = await import("net");
    //   await new Promise<void>((resolve, reject) => {
    //     const socket = net.createConnection({ host: output.printer, port: 9100 });
    //     socket.on("connect", () => { socket.write(finalPayload); socket.end(); });
    //     socket.on("close",   () => resolve());
    //     socket.on("error",   reject);
    //   });
    //
    // For HTML / IPP:
    //   const printResponse = await fetch(`http://${output.printer}/print`, {
    //     method: "POST",
    //     headers: { "Content-Type": template.output_mode === "zpl" ? "text/plain" : "text/html" },
    //     body: finalPayload,
    //     signal: AbortSignal.timeout(10_000),
    //   });
    //   if (!printResponse.ok) throw new Error(`Printer rejected job: ${printResponse.status}`);

    // ── STUB WARNING ──────────────────────────────────────────────────────────
    console.warn(
      `[API3] STUB: Printer call SKIPPED for output ${outputId} ` +
      `(printer="${output.printer}" mode=${template.output_mode}). ` +
      `Uncomment the real printer call in printWorker.ts to enable printing.`
    );

    // ── 6. Mark Success ───────────────────────────────────────────────────────
    await finalizeOutput(outputId, "Success", null, startTime);
    console.info(`[API3] Output ${outputId} processed successfully (${template.output_mode})`);

  } catch (err: any) {
    console.error(`[API3] Output processing error for ${outputId}:`, err.message);
    await handleFailure(outputId, err.message, startTime);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function handleFailure(
  outputId: string,
  errorMessage: string,
  startTime: number
): Promise<void> {
  const result = await pool.query(
    `UPDATE outputs
     SET retries = retries + 1, error_message = $1
     WHERE output_id = $2
     RETURNING retries`,
    [errorMessage, outputId]
  );

  const updatedRetries: number = result.rows[0]?.retries ?? MAX_RETRIES;

  if (updatedRetries >= MAX_RETRIES) {
    await finalizeOutput(outputId, "Failed", errorMessage, startTime);
    console.error(
      `[API3] Output ${outputId} permanently Failed after ${updatedRetries} retries`
    );
  } else {
    const durationMs = Date.now() - startTime;
    await pool.query(
      `UPDATE outputs
       SET status = 'Pending', duration = $1, completed_at = NULL
       WHERE output_id = $2`,
      [durationMs, outputId]
    );
    console.warn(
      `[API3] Output ${outputId} will retry (attempt ${updatedRetries}/${MAX_RETRIES})`
    );
  }
}

async function finalizeOutput(
  outputId: string,
  status: string,
  errorMessage: string | null,
  startTime: number
): Promise<void> {
  const durationMs = Date.now() - startTime;
  await pool.query(
    `UPDATE outputs
     SET status = $1, error_message = $2, duration = $3, completed_at = NOW()
     WHERE output_id = $4`,
    [status, errorMessage, durationMs, outputId]
  );
}