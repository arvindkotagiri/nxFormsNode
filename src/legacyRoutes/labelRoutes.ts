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

router.delete('/labels/:uuid', async (req, res) => {
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

