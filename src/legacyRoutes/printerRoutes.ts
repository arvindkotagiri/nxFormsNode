// @ts-nocheck
import express from 'express';
import net from 'net';
import { pool } from '../db';

const router = express.Router();

function sendToPrinter(ip, port, data) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(10000); // 10 seconds timeout

    socket.connect(parseInt(port, 10), ip, () => {
      socket.write(data, 'utf8', () => {
        socket.end();
        resolve({ success: true, error: null });
      });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ success: false, error: err.message });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ success: false, error: 'Connection timeout' });
    });
  });
}

router.post('/init-db', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS printer_master (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name VARCHAR(255) NOT NULL,
          ip_address VARCHAR(15) NOT NULL,
          site_id VARCHAR(50) NOT NULL,
          type VARCHAR(50) DEFAULT 'ZEBRA',
          status VARCHAR(20) DEFAULT 'Online',
          created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS print_jobs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          printer_id UUID REFERENCES printer_master(id),
          site_id VARCHAR(50) NOT NULL,
          payload TEXT NOT NULL,
          copies INT DEFAULT 1,
          status VARCHAR(20) DEFAULT 'PENDING',
          error_msg TEXT,
          created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      res.status(200).json({ status: "success", message: "Tables created" });
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/printers', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM printer_master ORDER BY created_on DESC");
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/printers', async (req, res) => {
  try {
    const data = req.body || {};
    const name = data.name;
    const ip_address = data.ip_address;
    const site_id = data.site_id;
    const printer_type = data.type || 'ZEBRA';

    const result = await pool.query(
      "INSERT INTO printer_master (name, ip_address, site_id, type) VALUES ($1, $2, $3, $4) RETURNING id",
      [name, ip_address, site_id, printer_type]
    );

    const newId = result.rows[0].id;
    res.status(201).json({ status: "success", id: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/printers/:printer_id', async (req, res) => {
  try {
    const { printer_id } = req.params;
    await pool.query("DELETE FROM printer_master WHERE id = $1", [printer_id]);
    res.status(200).json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/print-zpl', async (req, res) => {
  try {
    const data = req.body || {};
    const printer_id = data.printer_id;
    const payload = data.payload; // ZPL string
    const site_id = data.site_id;
    const copies = data.copies !== undefined ? data.copies : 1;

    const result = await pool.query(
      "INSERT INTO print_jobs (printer_id, site_id, payload, copies, status) VALUES ($1, $2, $3, $4, 'PENDING') RETURNING id",
      [printer_id, site_id, payload, copies]
    );

    const jobId = result.rows[0].id;
    res.status(202).json({ status: "queued", job_id: jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/jobs/pending/:site_id', async (req, res) => {
  const { site_id } = req.params;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const selectQuery = `
        SELECT j.id, j.payload, j.copies, p.ip_address, p.type
        FROM print_jobs j
        JOIN printer_master p ON j.printer_id = p.id
        WHERE j.site_id = $1 AND j.status = 'PENDING'
        ORDER BY j.created_on ASC;
      `;
      const result = await client.query(selectQuery, [site_id]);
      const jobs = result.rows;

      if (jobs.length > 0) {
        const jobIds = jobs.map(j => j.id);
        const updateQuery = "UPDATE print_jobs SET status = 'PROCESSING', updated_on = NOW() WHERE id = ANY($1)";
        await client.query(updateQuery, [jobIds]);
      }

      await client.query('COMMIT');
      res.status(200).json(jobs);
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/jobs/:job_id/status', async (req, res) => {
  const { job_id } = req.params;
  try {
    const data = req.body || {};
    const status = data.status;
    const error_msg = data.error_msg || null;

    await pool.query(
      "UPDATE print_jobs SET status = $1, error_msg = $2, updated_on = NOW() WHERE id = $3",
      [status, error_msg, job_id]
    );

    res.status(200).json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/direct-print', async (req, res) => {
  try {
    const data = req.body || {};
    const ip = data.ip_address;
    const payload = data.payload;
    const port = data.port || 9100;

    if (!ip || !payload) {
      return res.status(400).json({ error: "Missing IP or payload" });
    }

    const { success, error } = await sendToPrinter(ip, port, payload);
    if (success) {
      res.status(200).json({ status: "success" });
    } else {
      res.status(500).json({ status: "failed", error: error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

