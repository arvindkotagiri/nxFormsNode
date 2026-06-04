import { Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { verifyToken } from "../utils/jwt";

export type AuthedRequest = Request & {
  user?: {
    id: string;
    email: string;
    name: string;
    role: "viewer" | "configurator";
    created_by: string | null;
    created_on: string;
    updated_by: string | null;
    updated_on: string | null;
  };
};

export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const token = header.slice("Bearer ".length).trim();
    const payload = verifyToken(token);

    const result = await pool.query(
      `SELECT id::text, email, name, role, created_by, created_on::text, updated_by, updated_on::text
       FROM users
       WHERE id = $1`,
      [payload.sub]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });

    req.user = user;
    next();
  } catch (err: any) {
    const msg = err?.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    return res.status(401).json({ error: msg });
  }
}

export function requireConfigurator(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== "configurator") {
    return res.status(403).json({ error: "Configurator role required" });
  }
  next();
}
