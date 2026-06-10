// @ts-nocheck
import express from 'express';
import { pool } from '../db';

const router = express.Router();

router.get('/labels', async (req, res) => {
  try {
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
        xdp_code
      FROM label_master
      ORDER BY created_on DESC;
    `;

    const result = await pool.query(query);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching labels:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

