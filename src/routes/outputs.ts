import { Router } from "express";
import { pool } from "../db";
import { auditSelectSql } from "../utils/audit";
import { maybeDecryptPayload } from "../utils/dataEncryption";

const router = Router();

/**
 * GET /api/outputs
 * Returns paginated lightweight outputs (omits heavy decrypt payload per item)
 */
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || "20"), 10)));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();

    const whereClauses: string[] = [];
    const params: any[] = [];

    if (status && status.toLowerCase() !== "all") {
      params.push(status);
      whereClauses.push(`LOWER(o.status) = LOWER($${params.length})`);
    }

    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      whereClauses.push(`(o.form_id ILIKE ${p} OR o.printer ILIKE ${p} OR CAST(e.event_number AS TEXT) ILIKE ${p})`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // Total count
    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM outputs o JOIN events e ON o.event_id = e.event_id ${whereSql}`,
      params
    );
    const total = parseInt(countRes.rows[0].total || "0", 10);
    const totalPages = Math.ceil(total / limit) || 1;

    params.push(limit, offset);
    const limitOffsetSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(
      `
      SELECT
        o.output_id,
        o.event_id,
        e.event_number,
        o.form_id,
        o.printer,
        o.format,
        o.status,
        o.retries,
        o.duration,
        o.error_message,
        o.output_number,
        ${auditSelectSql("o")}
      FROM outputs o
      JOIN events e ON o.event_id = e.event_id
      ${whereSql}
      ORDER BY e.event_number DESC, o.output_number DESC
      ${limitOffsetSql}
    `,
      params.slice(0, params.length)
    );

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
      outputNumber: r.output_number,
      created_by: r.created_by,
      created_on: r.created_on,
      updated_by: r.updated_by,
      updated_on: r.updated_on,
    }));

    res.setHeader("Cache-Control", "no-store");
    if (req.query.page || req.query.limit || req.query.paginated === "true") {
      res.json({
        data: formatted,
        total,
        page,
        totalPages,
        limit,
      });
    } else {
      res.json(formatted);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch outputs" });
  }
});

/**
 * GET /api/outputs/:id
 * Fetches single output with rendered_output payload
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `
      SELECT
        o.output_id,
        o.event_id,
        e.event_number,
        o.form_id,
        o.printer,
        o.format,
        o.status,
        o.retries,
        o.duration,
        o.error_message,
        o.rendered_output,
        o.encrypted_payload,
        o.output_number,
        ${auditSelectSql("o")}
      FROM outputs o
      JOIN events e ON o.event_id = e.event_id
      WHERE o.output_id = $1
    `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Output not found" });
    }

    const r = result.rows[0];
    let decryptedPayload: any = null;
    if (r.encrypted_payload) {
      try {
        decryptedPayload = maybeDecryptPayload(r.encrypted_payload) as any;
      } catch (err) {
        console.warn("Failed to decrypt output payload:", err);
      }
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      id: r.output_id,
      eventId: r.event_id,
      evt_no: r.event_number,
      formId: r.form_id,
      printer: decryptedPayload?.printer ?? r.printer,
      format: decryptedPayload?.format ?? r.format,
      status: decryptedPayload?.status ?? r.status,
      retries: decryptedPayload?.retries ?? r.retries,
      duration: r.duration ? `${r.duration}ms` : "–",
      errorMessage: decryptedPayload?.error_message ?? r.error_message,
      renderedOutput: decryptedPayload?.rendered_output ?? r.rendered_output,
      outputNumber: r.output_number,
      created_by: r.created_by,
      created_on: r.created_on,
      updated_by: r.updated_by,
      updated_on: r.updated_on,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch output detail" });
  }
});

export default router;
