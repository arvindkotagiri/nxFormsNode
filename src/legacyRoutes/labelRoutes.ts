// @ts-nocheck
import express from 'express';
import { pool } from '../db';

const router = express.Router();

// GET /labels or /api/labels (supports pagination and summary mode)
router.get(['/labels', '/api/labels'], async (req, res) => {
  try {
    const summary = req.query.summary !== "false";
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || "50"), 10)));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || "").trim();

    const whereClauses: string[] = [];
    const params: any[] = [];

    // Optional user token extraction to filter by tenant_id
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const { verifyToken } = require('../utils/jwt');
        const token = authHeader.slice(7).trim();
        const decoded = verifyToken(token);
        if (decoded?.sub) {
          const userRes = await pool.query('SELECT role, tenant_id FROM users WHERE id = $1', [decoded.sub]);
          const user = userRes.rows[0];
          if (user && user.role !== 'admin' && user.tenant_id) {
            params.push(user.tenant_id);
            whereClauses.push(`tenant_id = $${params.length}`);
          }
        }
      } catch (tokenErr) {
        // Continue without filter if token is invalid or missing
      }
    }

    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      whereClauses.push(`(label_name ILIKE ${p} OR label_id ILIKE ${p} OR context ILIKE ${p})`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // Count total records
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM label_master ${whereSql}`, params);
    const total = parseInt(countRes.rows[0].total || "0", 10);
    const totalPages = Math.ceil(total / limit) || 1;

    // Fields selection
    const selectFields = summary
      ? `uuid, label_id, label_name, context, bar_code_type, version, created_by, created_on, page_dimensions, output_mode, tenant_id`
      : `uuid, label_id, label_name, context, field_mapping, bar_code_type, zpl_code, html_code, fields, version, created_by, created_on, page_dimensions, output_mode, xdp_code, tenant_id, table_config`;

    params.push(limit, offset);
    const limitOffsetSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const query = `
      SELECT ${selectFields}
      FROM label_master
      ${whereSql}
      ORDER BY created_on DESC
      ${limitOffsetSql};
    `;

    const result = await pool.query(query, params);
    res.setHeader("Cache-Control", "no-store");

    // If client requested paginated metadata format, return paginated object. Otherwise return rows for backward compatibility if page param omitted
    if (req.query.page || req.query.limit || req.query.paginated === "true") {
      res.status(200).json({
        data: result.rows,
        total,
        page,
        totalPages,
        limit,
      });
    } else {
      res.status(200).json(result.rows);
    }
  } catch (err) {
    console.error("Error fetching labels:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET single label with complete html_code, zpl_code, xdp_code
router.get(['/labels/:uuid', '/api/labels/:uuid'], async (req, res) => {
  try {
    const { uuid } = req.params;
    const result = await pool.query(
      `SELECT 
        uuid, label_id, label_name, context, field_mapping, bar_code_type, 
        zpl_code, html_code, fields, version, created_by, created_on, 
        page_dimensions, output_mode, xdp_code, tenant_id, table_config
       FROM label_master WHERE uuid = $1`,
      [uuid]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Label template not found" });
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching single label:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete(['/labels/:uuid', '/api/labels/:uuid'], async (req, res) => {
  try {
    const { uuid } = req.params;
    const query = `
      DELETE FROM label_master
      WHERE uuid = $1
      RETURNING uuid;
    `;
    const result = await pool.query(query, [uuid]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Label template not found" });
    }
    res.status(200).json({ status: "success", message: "Label template deleted successfully" });
  } catch (err) {
    console.error("Error deleting label:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
