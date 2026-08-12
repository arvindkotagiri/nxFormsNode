// routes/dashboard.ts
import { Router } from "express";
import { pool } from "../db";

const router = Router();

// GET /api/dashboard
router.get("/", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    // 1. Saved Templates Count & Output Mode Distribution
    // Real table: label_master (columns: label_id, label_name, output_mode, created_on)
    let totalTemplates = 0;
    let templateModes: any[] = [];
    try {
      const templatesRes = await pool.query(`
        SELECT 
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(output_mode, '')) = 'zpl')::int AS zpl_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(output_mode, '')) = 'html')::int AS html_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(output_mode, '')) = 'xdp')::int AS xdp_count,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(output_mode, '')) IN ('all', 'both'))::int AS multi_count
        FROM label_master
      `);
      if (templatesRes.rows.length > 0) {
        const row = templatesRes.rows[0];
        totalTemplates = Number(row.total || 0);
        const zpl = Number(row.zpl_count || 0);
        const html = Number(row.html_count || 0);
        const xdp = Number(row.xdp_count || 0);
        const multi = Number(row.multi_count || 0);
        const unassigned = Math.max(0, totalTemplates - (zpl + html + xdp + multi));

        templateModes = [
          { name: "ZPL Labels", value: zpl + unassigned, color: "#3b82f6" },
          { name: "HTML / Document", value: html, color: "#10b981" },
          { name: "Adobe XDP / Form", value: xdp, color: "#8b5cf6" },
          { name: "Multi-Format", value: multi, color: "#f59e0b" },
        ];
      }
    } catch (e: any) {
      console.warn("[Dashboard Backend] label_master query warning:", e.message);
    }

    // 2. AI LLM Traces Metrics
    // Real table: llm_traces (columns: id, agent_name, model_used, prompt_tokens, completion_tokens, total_tokens, duration_ms, status, created_at)
    let totalLlmCalls = 0;
    let totalTokensUsed = 0;
    let avgLlmLatencyMs = 0;
    let recentTraces: any[] = [];
    try {
      const tracesRes = await pool.query(`
        SELECT 
          COUNT(*)::int AS total,
          COALESCE(SUM(total_tokens), 0)::int AS total_tokens,
          COALESCE(AVG(duration_ms), 0)::int AS avg_ms
        FROM llm_traces
      `);
      if (tracesRes.rows.length > 0) {
        totalLlmCalls = Number(tracesRes.rows[0].total || 0);
        totalTokensUsed = Number(tracesRes.rows[0].total_tokens || 0);
        avgLlmLatencyMs = Number(tracesRes.rows[0].avg_ms || 0);
      }

      const recentTracesRes = await pool.query(`
        SELECT 
          id,
          agent_name,
          model_used AS model,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          duration_ms,
          status,
          created_at AS timestamp
        FROM llm_traces
        ORDER BY created_at DESC
        LIMIT 5
      `);
      recentTraces = recentTracesRes.rows;
    } catch (e: any) {
      console.warn("[Dashboard Backend] llm_traces query warning:", e.message);
    }

    // 3. Events Metrics
    // Real table: events (columns: event_id, source, context, event_type, event_timestamp, created_on)
    let totalEvents = 0;
    let recentEvents: any[] = [];
    try {
      const eventsRes = await pool.query(`SELECT COUNT(*)::int AS total FROM events`);
      if (eventsRes.rows.length > 0) {
        totalEvents = Number(eventsRes.rows[0].total || 0);
      }

      const recentEventsRes = await pool.query(`
        SELECT 
          event_id,
          event_type,
          source,
          context,
          event_timestamp AS timestamp
        FROM events
        ORDER BY event_timestamp DESC
        LIMIT 5
      `);
      recentEvents = recentEventsRes.rows;
    } catch (e: any) {
      console.warn("[Dashboard Backend] events query warning:", e.message);
    }

    // 4. Output Status Jobs Metrics
    // Real table: outputs (columns: output_id, event_id, form_id, printer, format, status, retries, duration, created_on)
    let totalOutputs = 0;
    let successOutputs = 0;
    let failedOutputs = 0;
    let pendingOutputs = 0;
    let avgOutputDurationMs = 0;
    let recentOutputs: any[] = [];
    try {
      const outputsRes = await pool.query(`
        SELECT 
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'success')::int AS success,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('failed', 'error'))::int AS failed,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'queued'))::int AS pending,
          COALESCE(AVG(duration), 0)::int AS avg_duration
        FROM outputs
      `);
      if (outputsRes.rows.length > 0) {
        const r = outputsRes.rows[0];
        totalOutputs = Number(r.total || 0);
        successOutputs = Number(r.success || 0);
        failedOutputs = Number(r.failed || 0);
        pendingOutputs = Number(r.pending || 0);
        avgOutputDurationMs = Number(r.avg_duration || 0);
      }

      const recentOutputsRes = await pool.query(`
        SELECT output_id, event_id, form_id, printer, format, status, duration, created_on
        FROM outputs
        ORDER BY created_on DESC
        LIMIT 5
      `);
      recentOutputs = recentOutputsRes.rows;
    } catch (e: any) {
      console.warn("[Dashboard Backend] outputs query warning:", e.message);
    }

    // 5. Printers Count (printer_master)
    let totalPrinters = 0;
    try {
      const pmRes = await pool.query(`SELECT COUNT(*)::int AS total FROM printer_master`);
      totalPrinters = Number(pmRes.rows[0]?.total || 0);
    } catch (e: any) {
      try {
        const printersRes = await pool.query(`SELECT COUNT(*)::int AS total FROM printers`);
        totalPrinters = Number(printersRes.rows[0]?.total || 0);
      } catch (err: any) {
        console.warn("[Dashboard Backend] printer query warning:", err.message);
      }
    }

    // Return combined clean dashboard payload
    res.json({
      summary: {
        totalTemplates,
        totalLlmCalls,
        totalEvents,
        totalOutputs,
        successOutputs,
        failedOutputs,
        pendingOutputs,
        totalPrinters,
        totalTokensUsed,
        avgLlmLatencyMs,
        avgOutputDurationMs,
      },
      templateModes,
      recentTraces,
      recentEvents,
      recentOutputs,
    });
  } catch (err: any) {
    console.error("[Dashboard Route Error]", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;