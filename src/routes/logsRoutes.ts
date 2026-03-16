// routes/logs.ts
import { Router } from "express";
import { pool } from "../db";

const router = Router();

// GET /api/logs
router.get("/", async (req, res) => {
  try {
    // optional query params
    const { level, service, search, limit, offset } = req.query;
    const l = Math.min(Number(limit ?? 100), 1000); // max 1000
    const o = Number(offset ?? 0);

    const where: string[] = [];
    const params: any[] = [];

    if (level) {
      params.push(level);
      where.push(`level = $${params.length}`);
    }

    if (service) {
      params.push(service);
      where.push(`service = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      params.push(`%${search}%`);
      params.push(`%${search}%`);
      where.push(`(message ILIKE $${params.length - 2} OR trace_id ILIKE $${params.length - 1} OR username ILIKE $${params.length})`);
    }

    const query = `
      SELECT
        log_id,
        level,
        service,
        message,
        username,
        trace_id,
        metadata,
        to_char(event_timestamp, 'YYYY-MM-DD HH24:MI:SS') AS ts,
        created_at
      FROM logs_audit
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY event_timestamp DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    params.push(l, o);

    const result = await pool.query(query, params);

    // format for frontend
    const formatted = result.rows.map((r: any) => ({
      id: r.log_id,
      level: r.level,
      service: r.service,
      message: r.message,
      ts: r.ts,
      user: r.username,
      traceId: r.trace_id,
      metadata: r.metadata ?? null,
      createdAt: r.created_at,
    }));

    // prevent caching (avoid 304 Not Modified)
    res.setHeader("Cache-Control", "no-store");
    res.json(formatted);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch logs" });
  }
});

export default router;