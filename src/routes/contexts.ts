import { Router } from "express";
import { pool } from "../db";
import { AUDIT_SELECT_SQL } from "../utils/audit";
import { maybeDecryptPayload } from "../utils/dataEncryption";

const router = Router();

/**
 * GET /api/contexts
 * Returns all contexts
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        endpoint,
        entities,
        fields,
        encrypted_payload,
        ${AUDIT_SELECT_SQL}
      FROM contexts
      ORDER BY name ASC
    `);

    const formatted = result.rows.map((r) => {
      let decryptedPayload: any = null;
      if (r.encrypted_payload) {
        try {
          decryptedPayload = maybeDecryptPayload(r.encrypted_payload) as any;
        } catch (err) {
          console.warn("Failed to decrypt context payload:", err);
        }
      }

      return {
        id: r.id,
        name: decryptedPayload?.name ?? r.name,
        endpoint: decryptedPayload?.endpoint ?? r.endpoint,
        entities: decryptedPayload?.entities ?? r.entities,
        fields: decryptedPayload?.fields ?? r.fields,
        created_by: r.created_by,
        created_on: r.created_on,
        updated_by: r.updated_by,
        updated_on: r.updated_on,
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contexts" });
  }
});

export default router;
