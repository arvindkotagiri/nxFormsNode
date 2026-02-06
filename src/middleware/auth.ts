import { Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { verifyToken } from "../utils/jwt";

export type AuthedRequest = Request & {
  user?: {
    id: string;
    email: string;
    name: string;
    role: "viewer" | "configurator";
    created_at: string;
  };
};

export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ detail: "Invalid token" });
    }

    const token = header.slice("Bearer ".length).trim();
    const payload = verifyToken(token);

    const result = await pool.query(
      `SELECT id::text, email, name, role, created_at::text
       FROM users
       WHERE id = $1`,
      [payload.sub]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ detail: "User not found" });

    req.user = user;
    next();
  } catch (err: any) {
    const msg = err?.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    return res.status(401).json({ detail: msg });
  }
}

export function requireConfigurator(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== "configurator") {
    return res.status(403).json({ detail: "Configurator role required" });
  }
  next();
}
