import { Router } from "express";
import { pool } from "../db";
import { requireUser, requireAdmin, AuthedRequest } from "../middleware/auth";
import { hashPassword } from "../utils/password";

const router = Router();

// Helper to generate next tenant ID for an organization
export async function getOrGenerateTenantId(orgName: string, customPrefix?: string): Promise<string> {
  const cleanOrg = orgName.trim();
  
  // Find or create organization record
  let res = await pool.query(`SELECT id, tenant_prefix, current_counter FROM organizations WHERE LOWER(name) = LOWER($1)`, [cleanOrg]);
  
  let prefix = customPrefix?.trim().toUpperCase();
  if (!prefix) {
    if (res.rows.length > 0 && res.rows[0].tenant_prefix) {
      prefix = res.rows[0].tenant_prefix;
    } else {
      // Derive default prefix from org name (e.g. "Wolters Kluwer" -> "WK")
      const words = cleanOrg.split(/\s+/).filter(Boolean);
      if (words.length >= 2) {
        prefix = (words[0][0] + words[1][0]).toUpperCase();
      } else {
        prefix = cleanOrg.substring(0, 3).toUpperCase();
      }
    }
  }

  let org;
  if (res.rows.length === 0) {
    const insertRes = await pool.query(
      `INSERT INTO organizations (name, tenant_prefix, current_counter) VALUES ($1, $2, 1) RETURNING *`,
      [cleanOrg, prefix]
    );
    org = insertRes.rows[0];
  } else {
    // Increment counter
    const updateRes = await pool.query(
      `UPDATE organizations SET current_counter = current_counter + 1, tenant_prefix = COALESCE($2, tenant_prefix) WHERE id = $1 RETURNING *`,
      [res.rows[0].id, prefix]
    );
    org = updateRes.rows[0];
  }

  const sequenceNum = String(org.current_counter).padStart(4, '0');
  return `${org.tenant_prefix}-MYGO-${sequenceNum}`;
}

// All admin routes require user authentication & admin role
router.use(requireUser);
router.use(requireAdmin);

// GET /api/admin/users - List all users
router.get("/users", async (req: AuthedRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT id::text, email, name, first_name, last_name, organization, tenant_id, status, role, created_on, updated_on
       FROM users
       ORDER BY CASE WHEN status = 'PENDING' THEN 0 ELSE 1 END, created_on DESC`
    );
    return res.json(result.rows);
  } catch (err: any) {
    console.error("[adminRoutes] Error listing users:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/approve-user - Approve pending user and assign tenant ID & role
router.post("/approve-user", async (req: AuthedRequest, res) => {
  try {
    const { userId, role = "developer", tenantPrefix, customTenantId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const userRes = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });

    const user = userRes.rows[0];
    const orgName = user.organization || "DefaultOrg";

    let tenantId = customTenantId?.trim();
    if (!tenantId) {
      tenantId = await getOrGenerateTenantId(orgName, tenantPrefix);
    }

    const updateRes = await pool.query(
      `UPDATE users
       SET status = 'APPROVED', role = $1, tenant_id = $2, updated_by = $3, updated_on = NOW()
       WHERE id = $4
       RETURNING id::text, email, name, first_name, last_name, organization, tenant_id, status, role`,
      [role, tenantId, req.user?.email || 'admin', userId]
    );

    console.log(`[adminRoutes] Approved user ${user.email} -> Tenant ID: ${tenantId}, Role: ${role}`);
    return res.json({
      message: `User ${user.email} approved successfully!`,
      user: updateRes.rows[0]
    });
  } catch (err: any) {
    console.error("[adminRoutes] Error approving user:", err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/update-user - Update user role, status, password, or tenant ID
router.post("/update-user", async (req: AuthedRequest, res) => {
  try {
    const { userId, role, status, tenantId, password } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const userRes = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });

    const updates: string[] = [];
    const params: any[] = [];

    const pushParam = (val: any) => {
      params.push(val);
      return `$${params.length}`;
    };

    if (role) updates.push(`role = ${pushParam(role)}`);
    if (status) updates.push(`status = ${pushParam(status)}`);
    if (tenantId) updates.push(`tenant_id = ${pushParam(tenantId)}`);
    if (password && password.trim().length >= 1) {
      const hash = await hashPassword(password.trim());
      updates.push(`password_hash = ${pushParam(hash)}`);
    }

    updates.push(`updated_by = ${pushParam(req.user?.email || 'admin')}`);
    updates.push(`updated_on = NOW()`);

    params.push(userId);
    const userIdParam = `$${params.length}`;

    const updateRes = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ${userIdParam} RETURNING id::text, email, name, first_name, last_name, organization, tenant_id, status, role`,
      params
    );

    return res.json({
      message: "User updated successfully",
      user: updateRes.rows[0]
    });
  } catch (err: any) {
    console.error("[adminRoutes] Error updating user:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/organizations - Get organization tenant mapping stats
router.get("/organizations", async (req: AuthedRequest, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, COUNT(u.id) AS user_count
       FROM organizations o
       LEFT JOIN users u ON LOWER(u.organization) = LOWER(o.name)
       GROUP BY o.id
       ORDER BY o.name ASC`
    );
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/organizations - Update organization tenant prefix
router.post("/organizations", async (req: AuthedRequest, res) => {
  try {
    const { name, tenantPrefix } = req.body;
    if (!name || !tenantPrefix) return res.status(400).json({ error: "name and tenantPrefix are required" });

    const cleanName = name.trim();
    const cleanPrefix = tenantPrefix.trim().toUpperCase();

    const resUpsert = await pool.query(
      `INSERT INTO organizations (name, tenant_prefix, current_counter)
       VALUES ($1, $2, 0)
       ON CONFLICT (name) DO UPDATE SET tenant_prefix = $2
       RETURNING *`,
      [cleanName, cleanPrefix]
    );

    return res.json({
      message: `Updated prefix for ${cleanName} to ${cleanPrefix}`,
      organization: resUpsert.rows[0]
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
