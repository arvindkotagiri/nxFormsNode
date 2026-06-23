import { Router } from "express";
import { pool } from "../db";
import { auditActor, AUDIT_SELECT_SQL } from "../utils/audit";
import { buildEncryptedPayload, maybeDecryptPayload } from "../utils/dataEncryption";
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
        encrypted_payload,
        ${AUDIT_SELECT_SQL}
      FROM simulation_master
      ORDER BY updated_on DESC NULLS LAST, created_on DESC
    `);

    const formatted = result.rows.map((r) => {
      let decryptedPayload: any = null;
      if (r.encrypted_payload) {
        try {
          decryptedPayload = maybeDecryptPayload(r.encrypted_payload) as any;
        } catch (err) {
          console.warn("Failed to decrypt simulation payload:", err);
        }
      }

      return {
        id: r.id,
        simulationName: decryptedPayload?.simulation_name ?? r.simulation_name,
        context: decryptedPayload?.context ?? r.context,
        form: decryptedPayload?.form ?? r.form,
        inputValues: decryptedPayload?.input_values ?? r.input_values,
        created_by: r.created_by,
        created_on: r.created_on,
        updated_by: r.updated_by,
        updated_on: r.updated_on,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch simulation records" });
  }
});

/**
 * POST /api/simulation
 * Inserts a new simulation record.
 * Body: { simulationName: string, context: string, inputValues: Record<string, string> }
 */
router.post("/", async (req: AuthedRequest, res) => {
  const { simulationName, context, form = "", inputValues } = req.body;

  if (!simulationName || !context) {
    return res
      .status(400)
      .json({ error: "simulationName and context are required" });
  }

  const actor = auditActor(req);

  try {
    const encryptedPayload = buildEncryptedPayload({
      simulation_name: simulationName,
      context,
      form,
      input_values: inputValues ?? {},
      created_by: actor,
      updated_by: actor,
    });

    const result = await pool.query(
      `
      INSERT INTO simulation_master (
        simulation_name, context, form, input_values, encrypted_payload,
        created_by, created_on, updated_by, updated_on
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW(), $6, NOW())
      RETURNING id, simulation_name, context, form, input_values, encrypted_payload, ${AUDIT_SELECT_SQL}
      `,
      [simulationName, context, form, JSON.stringify(inputValues ?? {}), encryptedPayload, actor]
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
