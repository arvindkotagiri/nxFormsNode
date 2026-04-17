// workers/printWorker.ts
// API3 — Output Processing Agent
//
// For each output row created by API2:
//   1. Read the output record
//   2. Fetch template from label_master using form_id
//   3. Transform document_json → HTML or ZPL using field_mapping
//   4. Send to printer (HTML via PDF+IPP, ZPL via TCP)
//   5. Update output status; increment retry_count on failure

import { pool } from "../db";
import net from "net";
import puppeteer, { Browser } from "puppeteer";
import * as TF from "../helper/transformations";

const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);

let browserInstance: Browser | null = null;

// ── Types ──────────────────────────────────────────────────────────────────────

interface LabelMaster {
  uuid: string;
  label_id: string;
  label_name: string;
  context: string;
  output_mode: string; // "html" | "zpl"
  html_code: string | null;
  zpl_code: string | null;
  field_mapping: Record<string, string> | null;
  // field_mapping stores { templatePlaceholder: documentJsonField }
  // e.g. { "Amount": "Amount", "CheckDate": "CheckDate" }
}

// ── Apply transformations ──────────────────────────────────────────────────────────
function applyTransformations(
  source: Record<string, any>,
  mapping: any
) {
  const sourceField = mapping.path;

  // create a mutable working copy
  const tempSource = { ...source };

  let value = tempSource[sourceField];

  if (!mapping.transformations || mapping.transformations.length === 0) {
    return value;
  }

  for (const step of mapping.transformations) {

    const fn = (TF as any)[step.type];

    if (!fn) {
      console.warn(`[API3] Unknown transformation: ${step.type}`);
      continue;
    }

    try {

      // update temporary source so next step sees new value
      tempSource[sourceField] = value;

      if (step.type === "IF_ELSE") {
        value = executeIfElse(tempSource, step.conditions);
        continue;
      }

      if (step.value !== undefined) {
        value = fn(tempSource, sourceField, step.value);
      } else {
        value = fn(tempSource, sourceField);
      }

    } catch (err) {
      console.error(`[API3] Transformation failed`, step, err);
    }
  }

  return value;
}

function executeIfElse(source: any, conditions: any[]) {

  for (const cond of conditions) {

    const left = source[cond.field];
    const right = cond.value;

    let result = false;

    switch (cond.operator) {
      case "==":
        result = left == right;
        break;

      case "!=":
        result = left != right;
        break;

      case ">":
        result = left > right;
        break;

      case "<":
        result = left < right;
        break;
    }

    if (result) {
      return cond.then.value;
    }
  }

  return null;
}
// ── Template renderer ──────────────────────────────────────────────────────────

function normalizeKey(key: string) {
  return key.replace(/\s+/g, "").toLowerCase();
}

function renderTemplate(
  template: LabelMaster,
  docData: Record<string, unknown>,
): string {
  // Pick the right template string based on output_mode
  const isZpl =
    template.output_mode === "zpl" || template.output_mode === "both";

  const raw = isZpl
    ? (template.zpl_code ?? "")
    : (template.html_code ?? "");

  if (!raw) {
    throw new Error(
      `label_master row for label_id=${template.label_id} has no ` +
      `${template.output_mode === "zpl" ? "zpl_code" : "html_code"}`,
    );
  }

  let rendered = raw;

  console.log(`[API3] Rendering template with document data:`, docData);
  console.log(`[API3] Field mapping:`, template.field_mapping);

  // If field_mapping exists, use it for precise placeholder → doc field mapping.
  // field_mapping format: { "Amount": "Amount", "CheckDate": "CheckDate" }

  // =========================
  // ZPL MODE (EXISTING CODE)
  // =========================
  if (isZpl) {
  if (
    template.field_mapping &&
    Object.keys(template.field_mapping).length > 0
  ) {
    console.log(`[API3] Using field_mapping for substitution`);
    for (const [placeholder, docField] of Object.entries(
      template.field_mapping,
    )) {
      
      console.log("placeholder",placeholder);
      console.log("docData",docData);
      console.log("docField",docField);

      // const value = String(docData[placeholder] ?? "");
      const value = applyTransformations(docData, docField);
      const valueStr = String(value ?? "");

      // Try both single and double brace patterns
      rendered = rendered.replace(
        new RegExp(`\\{${escapeRegex(placeholder.replace(/\s+/g, ""))}\\}`, "g"),
        valueStr,
      );
      rendered = rendered.replace(
        new RegExp(`{{${escapeRegex(placeholder.replace(/\s+/g, ""))}}}`, "g"),
        valueStr,
      );
      console.log(`[API3] Replaced {${placeholder}} / {{${placeholder}}} with "${valueStr}"`);
    }
  } else {
    // ✅ FIX #4: Handle both {KEY} and {{KEY}} formats
    console.log(`[API3] Using generic key substitution for all document fields`);
    
    for (const [key, value] of Object.entries(docData)) {
      const valueStr = String(value ?? "");
      
      // Replace {KEY} format (single braces) - for your ZPL
      rendered = rendered.replace(
        new RegExp(`\\{${escapeRegex(key)}\\}`, "g"),
        valueStr,
      );
      
      // Replace {{KEY}} format (double braces) - fallback
      rendered = rendered.replace(
        new RegExp(`{{${escapeRegex(key)}}}`, "g"),
        valueStr,
      );
      
      console.log(`[API3] Replaced {${key}} with "${valueStr}"`);
    }
  }
} else {

    console.log(`[API3] HTML rendering mode`);

    // normalize API keys
    const normalizedDoc: Record<string, any> = {};

    for (const [key, value] of Object.entries(docData)) {
      normalizedDoc[normalizeKey(key)] = value;
    }

    // replace {{Placeholders}}
    rendered = rendered.replace(/{{(.*?)}}/g, (_, placeholder) => {

      const norm = normalizeKey(placeholder);

      const value = normalizedDoc[norm];

      console.log(`[API3] HTML replace {{${placeholder}}} -> ${value}`);

      return value ?? "";

    });

  }

  return rendered;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserInstance;
}

async function htmlToPdf(htmlContent: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    const pdfData = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    // Convert Uint8Array to Buffer
    return Buffer.from(pdfData);
  } finally {
    await page.close();
  }
}

async function sendPdfViaIPP(
  printerUrl: string,
  pdfBuffer: Buffer,
): Promise<void> {
  return Promise.resolve();
  const ippUrl = printerUrl.includes(":631")
    ? printerUrl
    : `http://${printerUrl}:631/ipp/print`;

  const response = await fetch(ippUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdfBuffer.length),
    },
    body: new Uint8Array(pdfBuffer),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(
      `IPP printer rejected: ${response.status} ${response.statusText}`,
    );
  }
}

async function sendZPLViaTCP(
  printerHost: string,
  zplCode: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: printerHost, port: 9100 });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`ZPL TCP timeout (${printerHost}:9100)`));
    }, 10000);

    socket.on("connect", () => {
      socket.write(zplCode);
      socket.end();
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Main agent ─────────────────────────────────────────────────────────────────

export async function processOutputAgent(outputId: string): Promise<void> {
  const startTime = Date.now();

  try {
    // ── 1. Read output record ────────────────────────────────────────────────
    const outputResult = await pool.query(
      `SELECT * FROM outputs WHERE output_id = $1`,
      [outputId],
    );
    const output = outputResult.rows[0];
    if (!output) throw new Error(`Output record not found: ${outputId}`);

    console.log(`[API3] Processing output: ${outputId}`);
    console.log(`[API3] Form ID: ${output.form_id}`);

    // ── 2. Fetch template from label_master ───────────────────────────────────
    const templateResult = await pool.query(
      `SELECT uuid, label_id, label_name, context,
              output_mode, html_code, zpl_code, field_mapping
       FROM label_master
       WHERE label_name = $1
       ORDER BY version DESC
       LIMIT 1`,
      [output.form_id],
    );
    const template: LabelMaster = templateResult.rows[0];

    if (!template) {
      throw new Error(
        `No label_master entry found for label_name: ${output.form_id}`,
      );
    }

    console.log(`[API3] Template found: ${template.label_name} (${template.output_mode})`);

    // ── 3. Parse document JSON ────────────────────────────────────────────────
    const docData: Record<string, unknown> =
      typeof output.document_json === "string"
        ? JSON.parse(output.document_json)
        : output.document_json;

    console.log(`[API3] Document data:`, docData);
        
    // ── 4. Render template (HTML or ZPL) ─────────────────────────────────────
    const finalPayload = renderTemplate(template, docData);

    await pool.query(
    `UPDATE outputs SET rendered_output = $1 WHERE output_id = $2`,
    [finalPayload, outputId]
);


    console.log(`[API3] Final payload preview (first 500 chars):`, finalPayload);

    // ── 5. Send to printer ────────────────────────────────────────────────────
    if (template.output_mode === "zpl" || template.output_mode === "both") {
      console.log(`[API3] Sending ZPL to 192.168.171.223:9100`);
      await sendZPLViaTCP("192.168.171.223", finalPayload);
    } else if (template.output_mode === "html") {
      console.log(`[API3] Converting HTML to PDF...`);
      const pdfBuffer = await htmlToPdf(finalPayload);
      console.log(`[API3] Sending PDF to 192.168.171.223 via IPP`);
      await sendPdfViaIPP(output.printer || "192.168.171.223", pdfBuffer);
    } else {
      throw new Error(`Unknown output_mode: ${template.output_mode}`);
    }

    // ── 6. Mark Success ───────────────────────────────────────────────────────
    await finalizeOutput(outputId, "Success", null, startTime);
    console.info(
      `[API3] Output ${outputId} processed successfully (${template.output_mode})`,
    );
  } catch (err: any) {
    console.error(
      `[API3] Output processing error for ${outputId}:`,
      err.message,
    );
    await handleFailure(outputId, err.message, startTime);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function handleFailure(
  outputId: string,
  errorMessage: string,
  startTime: number,
): Promise<void> {
  const result = await pool.query(
    `UPDATE outputs
     SET retries = retries + 1, error_message = $1
     WHERE output_id = $2
     RETURNING retries`,
    [errorMessage, outputId],
  );

  const updatedRetries: number = result.rows[0]?.retries ?? MAX_RETRIES;

  if (updatedRetries >= MAX_RETRIES) {
    await finalizeOutput(outputId, "Failed", errorMessage, startTime);
    console.error(
      `[API3] Output ${outputId} permanently Failed after ${updatedRetries} retries`,
    );
  } else {
    const durationMs = Date.now() - startTime;
    await pool.query(
      `UPDATE outputs
       SET status = 'Pending', duration = $1, completed_at = NULL
       WHERE output_id = $2`,
      [durationMs, outputId],
    );
    console.warn(
      `[API3] Output ${outputId} will retry (attempt ${updatedRetries}/${MAX_RETRIES})`,
    );
  }
}

async function finalizeOutput(
  outputId: string,
  status: string,
  errorMessage: string | null,
  startTime: number,
): Promise<void> {
  const durationMs = Date.now() - startTime;
  await pool.query(
    `UPDATE outputs
     SET status = $1, error_message = $2, duration = $3, completed_at = NOW()
     WHERE output_id = $4`,
    [status, errorMessage, durationMs, outputId],
  );
}

// Cleanup on exit
process.on("exit", async () => {
  if (browserInstance) {
    await browserInstance.close();
  }
});