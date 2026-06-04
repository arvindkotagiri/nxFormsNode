import { Router } from "express";
import { pool } from "../db";
import { auditActor, AUDIT_SELECT_SQL } from "../utils/audit";
import type { AuthedRequest } from "../middleware/auth";

const router = Router();

/**
 * GET /api/simulation
 * Returns all simulation master records
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        simulation_name,
        context,
        form,
        input_values,
        ${AUDIT_SELECT_SQL}
      FROM simulation_master
      ORDER BY updated_on DESC NULLS LAST, created_on DESC
    `);

    const formatted = result.rows.map((r) => ({
      id: r.id,
      simulationName: r.simulation_name,
      context: r.context,
      form: r.form,
      inputValues: r.input_values,
      created_by: r.created_by,
      created_on: r.created_on,
      updated_by: r.updated_by,
      updated_on: r.updated_on,
    }));

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch simulation records" });
  }
});

/**
 * POST /api/simulation
 * Inserts a new simulation record.
 * Body: { simulationName: string, context: string, form: string, inputValues: Record<string, string> }
 */
router.post("/", async (req: AuthedRequest, res) => {
  const { simulationName, context, form, inputValues } = req.body;

  if (!simulationName || !context || !form) {
    return res
      .status(400)
      .json({ error: "simulationName, context and form are required" });
  }

  const actor = auditActor(req);

  try {
    const result = await pool.query(
      `
      INSERT INTO simulation_master (
        simulation_name, context, form, input_values,
        created_by, created_on, updated_by, updated_on
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), $5, NOW())
      RETURNING id, simulation_name, context, form, input_values, ${AUDIT_SELECT_SQL}
      `,
      [simulationName, context, form, JSON.stringify(inputValues ?? {}), actor]
    );

    const r = result.rows[0];
    res.status(201).json({
      id: r.id,
      simulationName: r.simulation_name,
      context: r.context,
      form: r.form,
      inputValues: r.input_values,
      created_by: r.created_by,
      created_on: r.created_on,
      updated_by: r.updated_by,
      updated_on: r.updated_on,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save simulation record" });
  }
});

export default router;
