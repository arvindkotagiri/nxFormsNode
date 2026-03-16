// routes/dashboard.ts
import { Router } from "express";
import { pool } from "../db";

const router = Router();

// GET /api/dashboard
router.get("/", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store"); 
    // 1️⃣ Total Outputs Today
    const totalOutTodayRes = await pool.query(`
      SELECT COUNT(*) AS total FROM outputs
      WHERE created_at >= CURRENT_DATE
    `);
    const totalOutputsToday = Number(totalOutTodayRes.rows[0].total);

    // 2️⃣ Processed Successfully
    const successRes = await pool.query(`
      SELECT COUNT(*) AS total FROM outputs
      WHERE status = 'Success' AND created_at >= CURRENT_DATE
    `);
    const processedSuccessfully = Number(successRes.rows[0].total);

    // 3️⃣ Failed
    const failedRes = await pool.query(`
      SELECT COUNT(*) AS total FROM outputs
      WHERE status = 'Failed' AND created_at >= CURRENT_DATE
    `);
    const failed = Number(failedRes.rows[0].total);

    // 4️⃣ Pending
    const pendingRes = await pool.query(`
      SELECT COUNT(*) AS total FROM outputs
      WHERE status = 'Pending' AND created_at >= CURRENT_DATE
    `);
    const pending = Number(pendingRes.rows[0].total);

    // 5️⃣ Avg Processing Time (ms)
    const avgTimeRes = await pool.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS avg_ms
      FROM outputs
      WHERE completed_at IS NOT NULL AND created_at >= CURRENT_DATE
    `);
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

    // Outputs by Context
    const outputsByContextRes = await pool.query(`
  SELECT e.context,
         COUNT(*) FILTER (WHERE o.status='Success') AS outputs,
         COUNT(*) FILTER (WHERE o.status='Failed') AS errors
  FROM outputs o
  JOIN events e ON o.event_id = e.event_id
  GROUP BY e.context
  ORDER BY outputs DESC
`);
    const outputsByContext = outputsByContextRes.rows.map((r: any) => ({
  name: r.context,
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
      SELECT date_trunc('hour', created_at) AS hour,
             AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) AS avg_ms
      FROM outputs
      WHERE created_at >= CURRENT_DATE AND completed_at IS NOT NULL
      GROUP BY hour
      ORDER BY hour
    `);
    const timeTrend = timeTrendRes.rows.map((r: any) => ({
      time: new Date(r.hour).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      ms: Math.round(r.avg_ms),
    }));

    // Printer Utilization (percentage of outputs per printer)
    const printerUtilRes = await pool.query(`
      SELECT printer, 
             COUNT(*) FILTER (WHERE status IS NOT NULL) * 100.0 / COUNT(*) AS util
      FROM outputs
      WHERE created_at >= CURRENT_DATE
      GROUP BY printer
      ORDER BY util DESC
    `);
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