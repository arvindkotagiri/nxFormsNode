import { Router } from "express";
import { pool } from "../db";

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
        created_at,
        updated_at
      FROM simulation_master
      ORDER BY updated_at DESC
    `);

    const formatted = result.rows.map((r) => ({
      id: r.id,
      simulationName: r.simulation_name,
      context: r.context,
      form: r.form,
      inputValues: r.input_values,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
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
router.post("/", async (req, res) => {
  const { simulationName, context, form, inputValues } = req.body;

  if (!simulationName || !context || !form) {
    return res
      .status(400)
      .json({ error: "simulationName, context and form are required" });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO simulation_master (simulation_name, context, form, input_values, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())
      RETURNING id, simulation_name, context, form, input_values, created_at, updated_at
      `,
      [simulationName, context, form, JSON.stringify(inputValues ?? {})]
    );

    const r = result.rows[0];
    res.status(201).json({
      id: r.id,
      simulationName: r.simulation_name,
      context: r.context,
      form: r.form,
      inputValues: r.input_values,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save simulation record" });
  }
});

export default router;