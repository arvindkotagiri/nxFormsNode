// routes/dashboard.ts
import { Router } from "express";
import { pool } from "../db";

const router = Router();

type DateRangeFilter = "today" | "last_24h" | "last_7d";

// GET /api/dashboard
router.get("/", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const dateRange = String(req.query.date_range ?? "today").toLowerCase() as DateRangeFilter;
    const context = String(req.query.context ?? "").trim();
    const source = String(req.query.source ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const printer = String(req.query.printer ?? "").trim();

    const params: Array<string> = [];
    const where: Array<string> = [];

    const pushParam = (value: string) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (dateRange === "last_24h") {
      where.push(`o.created_on >= NOW() - INTERVAL '24 hours'`);
    } else if (dateRange === "last_7d") {
      where.push(`o.created_on >= NOW() - INTERVAL '7 days'`);
    } else {
      where.push(`o.created_on >= CURRENT_DATE`);
    }

    if (context) {
      const p = pushParam(context);
      where.push(`(
        LOWER(TRIM(COALESCE(e.context, ''))) = LOWER(TRIM(${p}))
        OR LOWER(TRIM(COALESCE(c.name, ''))) = LOWER(TRIM(${p}))
      )`);
    }

    if (source) {
      const p = pushParam(`%${source}%`);
      where.push(`LOWER(COALESCE(e.source, '')) LIKE LOWER(${p})`);
    }

    if (status) {
      const p = pushParam(status);
      where.push(`LOWER(COALESCE(o.status, '')) = LOWER(${p})`);
    }

    if (printer) {
      const p = pushParam(printer);
      where.push(`LOWER(COALESCE(o.printer, '')) = LOWER(${p})`);
    }

    const filteredFrom = `
      FROM outputs o
      LEFT JOIN events e ON o.event_id = e.event_id
      LEFT JOIN contexts c ON (
        LOWER(TRIM(c.name)) = LOWER(TRIM(e.context))
        OR LOWER(TRIM(CAST(c.id AS TEXT))) = LOWER(TRIM(e.context))
      )
      WHERE ${where.join(" AND ")}
    `;

    // 1️⃣ Total Outputs Today
    const totalOutTodayRes = await pool.query(`
      SELECT COUNT(*) AS total
      ${filteredFrom}
    `, params);
    const totalOutputsToday = Number(totalOutTodayRes.rows[0].total);

    // 2️⃣ Processed Successfully
    const successRes = await pool.query(`
      SELECT COUNT(*) AS total
      ${filteredFrom}
      AND o.status = 'Success'
    `, params);
    const processedSuccessfully = Number(successRes.rows[0].total);

    // 3️⃣ Failed
    const failedRes = await pool.query(`
      SELECT COUNT(*) AS total
      ${filteredFrom}
      AND o.status = 'Failed'
    `, params);
    const failed = Number(failedRes.rows[0].total);

    // 4️⃣ Pending
    const pendingRes = await pool.query(`
      SELECT COUNT(*) AS total
      ${filteredFrom}
      AND o.status = 'Pending'
    `, params);
    const pending = Number(pendingRes.rows[0].total);

    // 5️⃣ Avg Processing Time (ms)
    const avgTimeRes = await pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_on)) * 1000) AS avg_ms
      ${filteredFrom}
      AND o.completed_at IS NOT NULL
    `, params);
    const avgProcessingTime = avgTimeRes.rows[0].avg_ms
      ? `${Math.round(avgTimeRes.rows[0].avg_ms)}ms`
      : "0ms";

    // KPI Cards
    const kpiCards = [
      { label: "Total Outputs Today", value: totalOutputsToday, icon: "FileOutput", trend: "", up: true },
      { label: "Processed Successfully", value: processedSuccessfully, icon: "CheckCircle", trend: "", up: true },
      { label: "Failed", value: failed, icon: "XCircle", trend: "", up: false },
      { label: "Pending", value: pending, icon: "Clock", trend: "", up: true },
      { label: "Avg Processing Time", value: avgProcessingTime, icon: "Timer", trend: "", up: false, isString: true },
    ];

    // Outputs by Context (case-insensitive merge; prefer catalog display name)
    const outputsByContextRes = await pool.query(`
      SELECT
        LOWER(TRIM(COALESCE(e.context, 'unknown'))) AS ctx_key,
        COALESCE(
          MAX(c.name),
          INITCAP(REPLACE(REPLACE(TRIM(MAX(e.context)), '_', ' '), '-', ' '))
        ) AS name,
        COUNT(*) FILTER (WHERE o.status = 'Success') AS outputs,
        COUNT(*) FILTER (WHERE o.status = 'Failed') AS errors
      ${filteredFrom}
      GROUP BY LOWER(TRIM(COALESCE(e.context, 'unknown')))
      ORDER BY outputs DESC
    `, params);
    const outputsByContext = outputsByContextRes.rows.map((r: any) => ({
      name: r.name,
      outputs: Number(r.outputs),
      errors: Number(r.errors),
    }));

    // Status Distribution
    const statusDist = [
      { name: "Success", value: processedSuccessfully, color: "hsl(var(--success))" },
      { name: "Failed", value: failed, color: "hsl(var(--error))" },
      { name: "Pending", value: pending, color: "hsl(var(--warning))" },
    ];

    // Processing Time Trend (hourly avg)
    const timeTrendRes = await pool.query(`
      SELECT date_trunc('hour', o.created_on) AS hour,
             AVG(EXTRACT(EPOCH FROM (o.completed_at - o.created_on)) * 1000) AS avg_ms
      ${filteredFrom}
      AND o.completed_at IS NOT NULL
      GROUP BY hour
      ORDER BY hour
    `, params);
    const timeTrend = timeTrendRes.rows.map((r: any) => ({
      time: new Date(r.hour).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      ms: Math.round(r.avg_ms),
    }));

    // Printer Utilization (percentage of outputs per printer)
    const printerUtilRes = await pool.query(`
      SELECT o.printer,
             COUNT(*) FILTER (WHERE o.status IS NOT NULL) * 100.0 / NULLIF(COUNT(*), 0) AS util
      ${filteredFrom}
      GROUP BY o.printer
      ORDER BY util DESC
    `, params);
    const printerUtil = printerUtilRes.rows.map((r: any) => ({
      name: r.printer,
      util: Math.round(r.util),
    }));

    res.json({
      kpiCards,
      outputsByContext,
      statusDist,
      timeTrend,
      printerUtil,
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;