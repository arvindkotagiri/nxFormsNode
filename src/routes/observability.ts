import { Router } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/observability/traces
router.get('/traces', async (req, res) => {
  try {
    const query = `
      SELECT id, trace_id, agent_name, model_used,
             prompt_tokens, completion_tokens, total_tokens,
             duration_ms, status, prompt, response,
             to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS ts
      FROM llm_traces
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err: any) {
    console.error('[Observability API] Error fetching traces:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch observability traces' });
  }
});

// DELETE /api/observability/traces
router.delete('/traces', async (req, res) => {
  try {
    await pool.query('DELETE FROM llm_traces');
    res.json({ status: 'success', message: 'All traces cleared' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to clear traces' });
  }
});

export default router;
