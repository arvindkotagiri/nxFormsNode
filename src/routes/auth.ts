import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { hashPassword, verifyPassword } from "../utils/password";
import { signToken } from "../utils/jwt";
import { requireUser, AuthedRequest } from "../middleware/auth";
import { auditActor, AUDIT_SELECT_SQL, auditSelectSql } from "../utils/audit";
import { buildEncryptedPayload, maybeDecryptPayload } from "../utils/dataEncryption";

const router = Router();

const userSignupSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required"),
  last_name: z.string().trim().min(1, "Last name is required"),
  organization: z.string().trim().min(1, "Organization is required"),
  email: z.string().trim().email("Valid email is required"),
  password: z.string().min(1, "Password is required"),
  confirm_password: z.string().min(1, "Confirm password is required"),
  role: z.enum(["admin", "manager", "developer", "operator", "viewer"]).optional().default("developer"),
}).refine((data) => data.password === data.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});

const userLoginSchema = z.object({
  email: z.string().trim().email("Valid email is required"),
  password: z.string().min(1, "Password is required"),
});

function tokenResponse(user: any, accessToken: string) {
  return {
    access_token: accessToken,
    token_type: "bearer",
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      first_name: user.first_name,
      last_name: user.last_name,
      organization: user.organization,
      tenant_id: user.tenant_id,
      status: user.status,
      role: user.role,
      created_by: user.created_by,
      created_on: user.created_on,
      updated_by: user.updated_by,
      updated_on: user.updated_on,
    },
  };
}

// POST /api/auth/register (Signup)
router.post("/register", async (req, res) => {
  const parsed = userSignupSchema.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const fieldName = firstIssue?.path[0] ? String(firstIssue.path[0]).replace('_', ' ') : '';
    const msg = firstIssue ? (fieldName ? `${fieldName}: ${firstIssue.message}` : firstIssue.message) : "Invalid input";
    return res.status(400).json({ detail: msg });
  }

  const { first_name, last_name, organization, email, password, role } = parsed.data;
  const fullName = `${first_name} ${last_name}`.trim();

  const existing = await pool.query(`SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  if (existing.rowCount) return res.status(400).json({ detail: "An account with this email already exists" });

  const passwordHash = await hashPassword(password);
  const actor = auditActor(req, email);

  const encryptedPayload = buildEncryptedPayload({
    email,
    name: fullName,
    first_name,
    last_name,
    organization,
    role,
    password_hash: passwordHash,
    created_by: actor,
    updated_by: actor,
  });

  const insert = await pool.query(
    `INSERT INTO users (email, name, first_name, last_name, organization, role, status, password_hash, created_by, created_on, updated_by, updated_on, encrypted_payload)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, NOW(), $8, NOW(), $9)
     RETURNING id::text, email, name, first_name, last_name, organization, tenant_id, status, role, ${AUDIT_SELECT_SQL}`,
    [email, fullName, first_name, last_name, organization, role, passwordHash, actor, encryptedPayload]
  );

  const user = insert.rows[0];
  return res.json({
    message: "Registration submitted successfully. Your account is pending admin approval.",
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      first_name: user.first_name,
      last_name: user.last_name,
      organization: user.organization,
      status: user.status,
      role: user.role
    }
  });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const parsed = userLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: "Email and password are required" });

  const { email, password } = parsed.data;

  const result = await pool.query(
    `SELECT id::text, email, name, first_name, last_name, organization, tenant_id, status, role, password_hash, encrypted_payload, ${auditSelectSql()}
     FROM users
     WHERE LOWER(email) = LOWER($1)`,
    [email]
  );

  let user = result.rows[0];
  if (!user) return res.status(401).json({ detail: "Invalid email or password" });

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ detail: "Invalid email or password" });

  // Check user status
  if (user.status === "PENDING") {
    return res.status(403).json({ detail: "Your account is pending approval by an admin. Please contact your system administrator." });
  }

  if (user.status === "REJECTED") {
    return res.status(403).json({ detail: "Your account registration was rejected by an admin." });
  }

  const accessToken = signToken({ sub: user.id, role: user.role });
  return res.json(tokenResponse(user, accessToken));
});

// GET /api/auth/me
router.get("/me", requireUser, async (req: AuthedRequest, res) => {
  return res.json(req.user);
});

export default router;
