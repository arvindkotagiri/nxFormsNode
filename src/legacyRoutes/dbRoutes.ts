// @ts-nocheck
import express from 'express';
import { pool } from '../db';

const router = express.Router();

router.post('/init-labels-db', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS label_master (
          uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          label_id VARCHAR(50),
          label_name VARCHAR(255),
          context TEXT,
          field_mapping JSONB,
          bar_code_type VARCHAR(50),
          zpl_code TEXT,
          html_code TEXT,
          fields JSONB,
          version NUMERIC,
          created_by VARCHAR(100),
          created_on TIMESTAMP,
          page_dimensions VARCHAR(50),
          output_mode VARCHAR(20)
        );
      `);

      await client.query(`
        DO $$ 
        BEGIN 
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='label_master' AND column_name='xdp_code') THEN
                ALTER TABLE label_master ADD COLUMN xdp_code TEXT;
            END IF;
        END $$;
      `);

      res.status(200).json({ status: "success", message: "Label table schema updated" });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

router.post('/save-label', async (req, res) => {
  try {
    const data = req.body || {};
    const label_id = data.label_id;
    const label_name = data.label_name;
    const context = data.context;
    const field_mapping = JSON.stringify(data.field_mapping || {});
    const bar_code_type = data.bar_code_type || '';
    const zpl_code = data.zpl_code || '';
    const html_code = data.html_code || '';
    const xdp_code = data.xdp_code || '';
    const page_dimensions = data.page_dimensions || '';
    const output_mode = data.output_mode || '';
    const fields = JSON.stringify(data.fields || []);
    const version = data.version !== undefined ? data.version : 1.0;
    const created_by = data.created_by || 'System';
    const created_on = new Date();

    const insertQuery = `
      INSERT INTO label_master (
        label_id, label_name, context, field_mapping, 
        bar_code_type, zpl_code, fields, version, 
        created_by, created_on,
        html_code, page_dimensions, output_mode, xdp_code
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING uuid;
    `;

    const values = [
      label_id, label_name, context, field_mapping,
      bar_code_type, zpl_code, fields, version,
      created_by, created_on,
      html_code, page_dimensions, output_mode, xdp_code
    ];

    const result = await pool.query(insertQuery, values);
    const newUuid = result.rows[0].uuid;

    res.status(201).json({ status: "success", uuid: newUuid });
  } catch (err) {
    console.error("Error saving label:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

