// @ts-nocheck
import express from 'express';
import { pool } from '../db';

const router = express.Router();

router.get(['/labels', '/api/labels'], async (req, res) => {
  try {
    let tenantFilter = "";
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
            tenantFilter = "WHERE tenant_id = $1";
            params.push(user.tenant_id);
          }
        }
      } catch (tokenErr) {
        // Continue without filter if token is invalid or missing
      }
    }

    const query = `
      SELECT 
        uuid,
        label_id,
        label_name,
        context,
        field_mapping,
        bar_code_type,
        zpl_code,
        html_code,
        fields,
        version,
        created_by,
        created_on,
        page_dimensions,
        output_mode,
        xdp_code,
        tenant_id,
        table_config
      FROM label_master
      ${tenantFilter}
      ORDER BY created_on DESC
      LIMIT 100;
    `;

    const result = await pool.query(query, params);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching labels:", err);
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

