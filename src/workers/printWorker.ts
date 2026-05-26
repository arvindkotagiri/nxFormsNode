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
  output_mode: string; // "html" | "zpl" | "xdp" | "all"
  html_code: string | null;
  zpl_code: string | null;
  xdp_code: string | null;
  field_mapping: Record<string, string> | null;
  // field_mapping stores { templatePlaceholder: documentJsonField }
  // e.g. { "Amount": "Amount", "CheckDate": "CheckDate" }
}

// ── Apply transformations ──────────────────────────────────────────────────────────
function applyTransformations(
  source: Record<string, any>,
  mapping: any
) {
  console.log("moo",source,"baa",mapping)
  // const sourceField = mapping.path;
  const sourceField = mapping.path.substring(mapping.path.lastIndexOf('.') + 1);;

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

// ── Two-pass transformation resolver ──────────────────────────────────────────
//
// Problem with one-pass approach:
//   A transformation on "Amount" might set "Plant" as its output (via IF_ELSE
//   cond.then.targetField or similar cross-field side-effects). If "Plant" hasn't
//   been processed yet, the value never lands in docData before substitution.
//
// Solution — two passes:
//   Pass 1: Walk every entry in field_mapping, run its transformations against
//           the CURRENT docData snapshot, and collect ALL results into a
//           resolvedValues map keyed by placeholder name.
//           We run all transformations first so cross-field writes are visible
//           before any placeholder substitution happens.
//   Pass 2: Substitute placeholders in the template string using resolvedValues.
//
// The function returns { resolvedValues, enrichedDoc } where:
//   resolvedValues — { [placeholder]: finalValue }  (used for substitution)
//   enrichedDoc    — original docData + any new keys written by transformations
//                    (useful for debugging / logging)

function resolveAllTransformations(
  fieldMapping: Record<string, any>,
  docData: Record<string, unknown>,
): { resolvedValues: Record<string, string>; enrichedDoc: Record<string, unknown> } {

  // Start with a mutable copy of docData so transformations that write new
  // fields are visible to subsequent transformations in the same pass.
  const enrichedDoc: Record<string, unknown> = { ...docData };
  const resolvedValues: Record<string, string> = {};

  console.log(`[API3] Pass 1 — resolving all transformations`);

  for (const [placeholder, mapping] of Object.entries(fieldMapping)) {
    const value = applyTransformations(enrichedDoc, mapping);
    const valueStr = String(value ?? "");

    // Write the result back into enrichedDoc so later transformations in this
    // same loop can reference it (e.g. a transformation on "Plant" that reads
    // the already-resolved "Amount").
    const targetKey = typeof mapping === "object" && mapping.path
      ? mapping.path
      : placeholder;

    enrichedDoc[targetKey] = value;

    resolvedValues[placeholder] = valueStr;

    console.log(
      `[API3]   placeholder="${placeholder}" path="${targetKey}" → "${valueStr}"`,
    );
  }

  console.log(`[API3] Pass 1 complete. enrichedDoc keys:`, Object.keys(enrichedDoc));

  return { resolvedValues, enrichedDoc };
}

// ── Template renderer ──────────────────────────────────────────────────────────

function normalizeKey(key: string) {
  return key.replace(/\s+/g, "").toLowerCase();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Substitutes {Placeholder} and {{Placeholder}} patterns in a raw template
// string using a pre-resolved values map.
function substituteValues(
  raw: string,
  resolvedValues: Record<string, string>,
): string {
  let rendered = raw;

  for (const [placeholder, valueStr] of Object.entries(resolvedValues)) {
    const safeKey = escapeRegex(placeholder.replace(/\s+/g, ""));

    rendered = rendered.replace(
      new RegExp(`\\{${safeKey}\\}`, "g"),
      valueStr,
    );
    rendered = rendered.replace(
      new RegExp(`{{${safeKey}}}`, "g"),
      valueStr,
    );

    console.log(
      `[API3]   Substituted {${placeholder}} / {{${placeholder}}} → "${valueStr}"`,
    );
  }

  return rendered;
}

// ── Mode-specific render functions ─────────────────────────────────────────────

function renderZpl(
  template: LabelMaster,
  docData: Record<string, unknown>,
): string {
  const raw = template.zpl_code ?? "";

  if (!raw) {
    throw new Error(
      `label_master row for label_id=${template.label_id} has no zpl_code`,
    );
  }

  console.log(`[API3] ZPL render — field_mapping:`, template.field_mapping);

  if (template.field_mapping && Object.keys(template.field_mapping).length > 0) {
    // Two-pass: resolve all transformations first, then substitute
    const { resolvedValues } = resolveAllTransformations(
      template.field_mapping,
      docData,
    );
    return substituteValues(raw, resolvedValues);
  }

  // No field_mapping — fall back to direct key substitution (no transformations)
  console.log(`[API3] ZPL — no field_mapping, using direct key substitution`);
  let rendered = raw;

  for (const [key, value] of Object.entries(docData)) {
    const valueStr = String(value ?? "");
    const safeKey = escapeRegex(key);

    rendered = rendered.replace(new RegExp(`\\{${safeKey}\\}`, "g"), valueStr);
    rendered = rendered.replace(new RegExp(`{{${safeKey}}}`, "g"), valueStr);

    console.log(`[API3]   Direct substituted {${key}} → "${valueStr}"`);
  }

  return rendered;
}

function renderHtml(
  template: LabelMaster,
  docData: Record<string, unknown>,
): string {
  const raw = template.html_code ?? "";

  if (!raw) {
    throw new Error(
      `label_master row for label_id=${template.label_id} has no html_code`,
    );
  }

  console.log(`[API3] HTML render — field_mapping:`, template.field_mapping);

  if (template.field_mapping && Object.keys(template.field_mapping).length > 0) {
    // Two-pass: resolve all transformations first, then substitute
    const { resolvedValues } = resolveAllTransformations(
      template.field_mapping,
      docData,
    );

    // HTML templates use {{Placeholder}} syntax
    return raw.replace(/{{(.*?)}}/g, (_, placeholder) => {
      const norm = normalizeKey(placeholder);

      // Check resolvedValues first (with normalized key), then fall back to
      // normalized docData lookup
      const resolved = Object.entries(resolvedValues).find(
        ([k]) => normalizeKey(k) === norm,
      );

      const value = resolved ? resolved[1] : "";
      console.log(`[API3]   HTML replace {{${placeholder}}} → "${value}"`);
      return value;
    });
  }

  // No field_mapping — normalize docData keys and substitute directly
  console.log(`[API3] HTML — no field_mapping, using normalized key substitution`);
  const normalizedDoc: Record<string, any> = {};

  for (const [key, value] of Object.entries(docData)) {
    normalizedDoc[normalizeKey(key)] = value;
  }

  return raw.replace(/{{(.*?)}}/g, (_, placeholder) => {
    const norm = normalizeKey(placeholder);
    const value = normalizedDoc[norm];
    console.log(`[API3]   HTML replace {{${placeholder}}} → ${value}`);
    return value ?? "";
  });
}

function renderXdp(
  template: LabelMaster,
  docData: Record<string, unknown>,
): string {
  const raw = template.xdp_code ?? "";

  if (!raw) {
    throw new Error(
      `label_master row for label_id=${template.label_id} has no xdp_code`,
    );
  }

  console.log(`[API3] XDP render — field_mapping:`, template.field_mapping);

  if (template.field_mapping && Object.keys(template.field_mapping).length > 0) {
    // Two-pass: resolve all transformations first, then substitute
    const { resolvedValues } = resolveAllTransformations(
      template.field_mapping,
      docData,
    );
    return substituteValues(raw, resolvedValues);
  }

  // No field_mapping — direct key substitution
  console.log(`[API3] XDP — no field_mapping, using direct key substitution`);
  let rendered = raw;

  for (const [key, value] of Object.entries(docData)) {
    const valueStr = String(value ?? "");
    const safeKey = escapeRegex(key);

    rendered = rendered.replace(new RegExp(`\\{${safeKey}\\}`, "g"), valueStr);
    rendered = rendered.replace(new RegExp(`{{${safeKey}}}`, "g"), valueStr);

    console.log(`[API3]   Direct substituted {${key}} → "${valueStr}"`);
  }

  return rendered;
}

// ── Printer dispatch functions ─────────────────────────────────────────────────

async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 
    (process.platform === 'linux' ? '/usr/bin/chromium' : undefined),
      headless: true,
      args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
    });
  }
  return browserInstance;
}

export async function htmlToPdf(htmlContent: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    const pdfData = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
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

// Sends a rendered ZPL payload to the printer
async function dispatchZpl(
  printerHost: string,
  template: LabelMaster,
  docData: Record<string, unknown>,
): Promise<void> {
  const zplPayload = renderZpl(template, docData);
  console.log(`[API3] ZPL payload preview:`, zplPayload.slice(0, 500));
  console.log(`[API3] Sending ZPL to ${printerHost}:9100`);
  await sendZPLViaTCP(printerHost, zplPayload);
}

// Renders HTML → PDF and sends via IPP
async function dispatchHtml(
  printerHost: string,
  template: LabelMaster,
  docData: Record<string, unknown>,
): Promise<void> {
  const htmlPayload = renderHtml(template, docData);
  console.log(`[API3] HTML payload preview:`, htmlPayload.slice(0, 500));
  console.log(`[API3] Converting HTML to PDF...`);
  const pdfBuffer = await htmlToPdf(htmlPayload);
  console.log(`[API3] Sending PDF to ${printerHost} via IPP`);
  await sendPdfViaIPP(printerHost, pdfBuffer);
}

// Renders and dispatches XDP (extend this when you have an XDP printer path)
async function dispatchXdp(
  printerHost: string,
  template: LabelMaster,
  docData: Record<string, unknown>,
): Promise<void> {
  const xdpPayload = renderXdp(template, docData);
  console.log(`[API3] XDP payload preview:`, xdpPayload.slice(0, 500));
  // TODO: implement actual XDP printer transport (e.g. HTTP POST to AEM/LiveCycle)
  console.log(`[API3] XDP dispatch to ${printerHost} — not yet implemented, payload logged`);
}

// ── OLD functions (untouched) ──────────────────────────────────────────────────

function renderTemplate(
  template: LabelMaster,
  docData: Record<string, unknown>,
): string {
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

      const value = applyTransformations(docData, docField);
      const valueStr = String(value ?? "");

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
    console.log(`[API3] Using generic key substitution for all document fields`);
    
    for (const [key, value] of Object.entries(docData)) {
      const valueStr = String(value ?? "");
      
      rendered = rendered.replace(
        new RegExp(`\\{${escapeRegex(key)}\\}`, "g"),
        valueStr,
      );
      
      rendered = rendered.replace(
        new RegExp(`{{${escapeRegex(key)}}}`, "g"),
        valueStr,
      );
      
      console.log(`[API3] Replaced {${key}} with "${valueStr}"`);
    }
  }
} else {

    console.log(`[API3] HTML rendering mode`);

    const normalizedDoc: Record<string, any> = {};

    for (const [key, value] of Object.entries(docData)) {
      normalizedDoc[normalizeKey(key)] = value;
    }

    rendered = rendered.replace(/{{(.*?)}}/g, (_, placeholder) => {

      const norm = normalizeKey(placeholder);

      const value = normalizedDoc[norm];

      console.log(`[API3] HTML replace {{${placeholder}}} -> ${value}`);

      return value ?? "";

    });

  }

  return rendered;
}

function newrenderTemplate(
  template: LabelMaster,
  docData: Record<string, unknown>,
): string {
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

      const value = applyTransformations(docData, docField);
      const valueStr = String(value ?? "");

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
    console.log(`[API3] Using generic key substitution for all document fields`);
    
    for (const [key, value] of Object.entries(docData)) {
      const valueStr = String(value ?? "");
      
      rendered = rendered.replace(
        new RegExp(`\\{${escapeRegex(key)}\\}`, "g"),
        valueStr,
      );
      
      rendered = rendered.replace(
        new RegExp(`{{${escapeRegex(key)}}}`, "g"),
        valueStr,
      );
      
      console.log(`[API3] Replaced {${key}} with "${valueStr}"`);
    }
  }
} else {

    console.log(`[API3] HTML rendering mode`);

    const normalizedDoc: Record<string, any> = {};

    for (const [key, value] of Object.entries(docData)) {
      normalizedDoc[normalizeKey(key)] = value;
    }

    rendered = rendered.replace(/{{(.*?)}}/g, (_, placeholder) => {

      const norm = normalizeKey(placeholder);

      const value = normalizedDoc[norm];

      console.log(`[API3] HTML replace {{${placeholder}}} -> ${value}`);

      return value ?? "";

    });

  }

  return rendered;
}

// ── OLD agent (untouched) ──────────────────────────────────────────────────────

export async function processOutputAgent(outputId: string): Promise<void> {
  const startTime = Date.now();

  try {
    const outputResult = await pool.query(
      `SELECT * FROM outputs WHERE output_id = $1`,
      [outputId],
    );
    const output = outputResult.rows[0];
    if (!output) throw new Error(`Output record not found: ${outputId}`);

    console.log(`[API3] Processing output: ${outputId}`);
    console.log(`[API3] Form ID: ${output.form_id}`);

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

    const docData: Record<string, unknown> =
      typeof output.document_json === "string"
        ? JSON.parse(output.document_json)
        : output.document_json;

    console.log(`[API3] Document data:`, docData);
        
    const finalPayload = renderTemplate(template, docData);

    await pool.query(
    `UPDATE outputs SET rendered_output = $1 WHERE output_id = $2`,
    [finalPayload, outputId]
);


    console.log(`[API3] Final payload preview (first 500 chars):`, finalPayload);

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

// ── NEW agent ──────────────────────────────────────────────────────────────────

export async function newprocessOutputAgent(outputId: string, simulate: boolean, props: any): Promise<void> {
  const startTime = Date.now();

  try {
    // ── 1. Read output record (join events for print_to_file flag) ───────────
    const outputResult = await pool.query(
      `SELECT o.*, e.print_to_file
       FROM outputs o
       LEFT JOIN events e ON e.event_id = o.event_id
       WHERE o.output_id = $1`,
      [outputId],
    );
    const output = outputResult.rows[0];
    if (!output) throw new Error(`Output record not found: ${outputId}`);

    const printToFile: boolean = output.print_to_file === true;

    console.log(`[API3] Processing output: ${outputId}`);
    console.log(`[API3] Form ID: ${output.form_id}`);

    // ── 2. Fetch template from label_master ───────────────────────────────────
    const templateResult = await pool.query(
      `SELECT uuid, label_id, label_name, context,
              output_mode, html_code, zpl_code, xdp_code, field_mapping
       FROM label_master
       WHERE label_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [output.form_id],
    );
    const template: LabelMaster = templateResult.rows[0];

    if (!template) {
      throw new Error(
        `No label_master entry found for label_id: ${output.form_id}`,
      );
    }

    console.log(
      `[API3] Template found: ${template.label_name} (${template.output_mode})`,
    );

    // ── 3. Parse document JSON ────────────────────────────────────────────────
    const docData: Record<string, unknown> =
      typeof output.document_json === "string"
        ? JSON.parse(output.document_json)
        : output.document_json;

    console.log(`[API3] Document data:`, docData);

    // ── 4. Render & dispatch (or save-to-file only) ───────────────────────────
    //
    // If print_to_file is TRUE on the linked event, we skip all printer
    // transports and only persist the rendered output to the DB.
    // The status flow (Success) is identical either way.

    console.log("output.printer", output.printer)
    // Get Printer Ip Address
    const printerIP = await pool.query(
      `SELECT ip_address
       FROM printer_master
       WHERE name = $1
       ORDER BY name DESC
       LIMIT 1`,
      [output.printer],
    );
    const printerHost: string = printerIP.rows[0]?.ip_address;
    console.log("simulate", simulate)
    if (!printerHost && simulate === false) {
      throw new Error(`Printer entry not found for id: ${output.printer}`);
    }
    console.log("executed");
    // Always render so rendered_output is saved regardless of print_to_file.
    const representativePayload =
      template.output_mode === "html"
        ? renderHtml(template, docData)
        : template.output_mode === "xdp"
          ? renderXdp(template, docData)
          : renderZpl(template, docData);

    // ── 5. Persist rendered output ────────────────────────────────────────────
    await pool.query(
      `UPDATE outputs SET rendered_output = $1 WHERE output_id = $2`,
      [representativePayload, outputId],
    );

    if (printToFile) {
      console.info(
        `[API3] print_to_file=true — skipping printer dispatch, output saved to DB`,
      );
      console.log(`[API3] Output ${outputId} saved to DB (print_to_file=true)`);
    } else {
      // ── Dispatch by output_mode ─────────────────────────────────────────────
      //
      // Each dispatch function:
      //   a) runs the two-pass transformation (resolveAllTransformations)
      //   b) substitutes placeholders into the mode-specific template
      //   c) sends the result to the appropriate printer transport
      //
      // "all" runs ZPL, XDP, and HTML sequentially. If one fails the error
      // bubbles up and the whole output is retried — adjust if you need
      // partial-success handling.
      console.log(`[API3] Dispatching to printer (print_to_file=false)`);
      switch (template.output_mode) {
        case "zpl":
          await dispatchZpl(printerHost, template, docData);
          break;

        case "html":
          await dispatchHtml(printerHost, template, docData);
          break;

        case "xdp":
          await dispatchXdp(printerHost, template, docData);
          break;

        case "all":
          console.log(`[API3] output_mode=all — running ZPL, XDP, HTML sequentially`);
          await dispatchZpl(printerHost, template, docData);
          await dispatchXdp(printerHost, template, docData);
          await dispatchHtml(printerHost, template, docData);
          break;

        default:
          throw new Error(`Unknown output_mode: ${template.output_mode}`);
      }
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