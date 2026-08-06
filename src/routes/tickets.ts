import { Router } from 'express';
import { pool } from '../db';
import path from 'path';
import fs from 'fs';

const router = Router();

const TICKETING_API_URL = "http://ec2-54-221-31-53.compute-1.amazonaws.com/api/tickets";
const EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY || "mygo-external-support-key";

// GET /api/support/tickets
router.get('/tickets', async (req, res) => {
  try {
    const query = `
       SELECT id, ticket_id, title, description, priority, status,
              category, subcategory, requestor_email, requestor_name,
              tenant_id, source, logs, screenshot,
              to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
              to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
       FROM support_tickets
       ORDER BY created_at DESC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err: any) {
    console.error('[Tickets Router] GET failed:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch tickets' });
  }
});

// POST /api/support/tickets
router.post('/tickets', async (req, res) => {
  try {
    const { title, description, priority, logs: clientLogs, requestorEmail, requestorName, tenantId, screenshot } = req.body;

    if (!title || !requestorEmail) {
      return res.status(400).json({ error: 'Title and requestorEmail are required' });
    }

    // 1. Retrieve server-side error logs (last 15 lines from error.log)
    let serverLogs: string[] = [];
    try {
      const logPath = path.join(process.cwd(), 'error.log');
      if (fs.existsSync(logPath)) {
        const logText = fs.readFileSync(logPath, 'utf8');
        const lines = logText.split('\n').filter(line => line.trim() !== '');
        serverLogs = lines.slice(-15);
      }
    } catch (logErr: any) {
      console.warn("⚠️ Failed to read error.log for support ticket:", logErr.message);
    }

    // 2. Filter & Combine client and server logs
    const combinedLogs: string[] = [];
    if (clientLogs && Array.isArray(clientLogs)) {
      const clientErrors = clientLogs.filter(l => l.includes('[ERROR]') || l.toLowerCase().includes('error'));
      combinedLogs.push(...clientErrors.map(l => `[CLIENT] ${l}`));
    }
    if (serverLogs && serverLogs.length > 0) {
      combinedLogs.push(...serverLogs.map(l => `[SERVER] ${l}`));
    }

    // 3. Build enriched payload
    const source = req.headers.host || "nxformsui.mygoapps.com";
    const payload = {
      title,
      description,
      category: "IT Operations",
      subcategory: "Software Issues",
      priority: priority || "Medium",
      tenantId: tenantId || "my-tenant-001",
      source,
      logs: combinedLogs,
      requestorEmail,
      requestorName: requestorName || requestorEmail.split('@')[0],
      screenshot // Include screenshot in the external payload
    };

    let ticketId = `TKT-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    let externalStatus = 'New';
    let rawExternalResponse = '';

    // 4. Proxy call to External AWS Ticketing Server
    try {
      console.log("🎟️ [Support Proxy] Raising ticket to external ticketing server...");
      const response = await fetch(TICKETING_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": EXTERNAL_API_KEY
        },
        body: JSON.stringify(payload)
      });

      rawExternalResponse = await response.text();
      if (response.ok) {
        const createdTicket = JSON.parse(rawExternalResponse);
        if (createdTicket.id) ticketId = createdTicket.id;
        if (createdTicket.status) externalStatus = createdTicket.status;
        console.log(`🎉 [Support Proxy] Ticket raised successfully: ${ticketId}`);
      } else {
        console.error(`❌ [Support Proxy] External ticketing returned error: ${response.status} - ${rawExternalResponse}`);
      }
    } catch (proxyErr: any) {
      console.error("❌ [Support Proxy] External ticketing request failed:", proxyErr.message);
    }

    // 5. Save a copy of the ticket in the local Postgres database
    const insertQuery = `
      INSERT INTO support_tickets (
        ticket_id, title, description, priority, status,
        category, subcategory, requestor_email, requestor_name,
        tenant_id, source, logs, screenshot
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;
    const dbResult = await pool.query(insertQuery, [
      ticketId,
      title,
      description,
      payload.priority,
      externalStatus,
      payload.category,
      payload.subcategory,
      payload.requestorEmail,
      payload.requestorName,
      payload.tenantId,
      payload.source,
      JSON.stringify(payload.logs),
      screenshot
    ]);

    res.status(201).json(dbResult.rows[0]);
  } catch (err: any) {
    console.error("❌ [Support Route] Error:", err);
    res.status(500).json({ error: 'Internal server error raising ticket', details: err.message });
  }
});

// PATCH /api/support/tickets/:ticketId - allows local status/priority updates
router.patch('/tickets/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status, priority } = req.body;
    
    const updateFields: string[] = [];
    const params: any[] = [ticketId];
    
    if (status) {
      params.push(status);
      updateFields.push(`status = $${params.length}`);
    }
    if (priority) {
      params.push(priority);
      updateFields.push(`priority = $${params.length}`);
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    const query = `
      UPDATE support_tickets
      SET ${updateFields.join(', ')}, updated_at = NOW()
      WHERE ticket_id = $1
      RETURNING *
    `;
    const result = await pool.query(query, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/support/tickets/:ticketId
router.delete('/tickets/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const result = await pool.query('DELETE FROM support_tickets WHERE ticket_id = $1 RETURNING *', [ticketId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    res.json({ status: 'success', message: 'Ticket deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
