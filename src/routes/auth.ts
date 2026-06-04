import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { hashPassword, verifyPassword } from "../utils/password";
import { signToken } from "../utils/jwt";
import { requireUser, AuthedRequest } from "../middleware/auth";
import { auditActor, AUDIT_SELECT_SQL } from "../utils/audit";

const router = Router();

const userCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["viewer", "configurator"]).optional().default("viewer"),
  password: z.string().min(6),
});

const userLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function tokenResponse(user: any, accessToken: string) {
  return {
    access_token: accessToken,
    token_type: "bearer",
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      created_by: user.created_by,
      created_on: user.created_on,
      updated_by: user.updated_by,
      updated_on: user.updated_on,
    },
  };
}

// POST /api/auth/register
router.post("/register", async (req, res) => {
  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.flatten() });

  const { email, name, role, password } = parsed.data;

  const existing = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
  if (existing.rowCount) return res.status(400).json({ detail: "Email already registered" });

  const passwordHash = await hashPassword(password);

  const actor = auditActor(req, email);

  const insert = await pool.query(
    `INSERT INTO users (email, name, role, password_hash, created_by, created_on, updated_by, updated_on)
     VALUES ($1, $2, $3, $4, $5, NOW(), $5, NOW())
     RETURNING id::text, email, name, role, ${AUDIT_SELECT_SQL}`,
    [email, name, role, passwordHash, actor]
  );

  const user = insert.rows[0];
  const accessToken = signToken({ sub: user.id, role: user.role });

  return res.json(tokenResponse(user, accessToken));
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const parsed = userLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ detail: parsed.error.flatten() });

  const { email, password } = parsed.data;

  const result = await pool.query(
    `SELECT id::text, email, name, role, password_hash, ${AUDIT_SELECT_SQL}
     FROM users
     WHERE email = $1`,
    [email]
  );

  const user = result.rows[0];
  if (!user) return res.status(401).json({ detail: "Invalid email or password" });

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ detail: "Invalid email or password" });

  const accessToken = signToken({ sub: user.id, role: user.role });
  return res.json(tokenResponse(user, accessToken));
});

// GET /api/auth/me
router.get("/me", requireUser, async (req: AuthedRequest, res) => {
  return res.json(req.user);
});

export default router;
