import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "label-config-secret-key-2024";
const EXPIRES_IN = "24h"; // matches your FastAPI 24 hours

export type JwtPayload = {
  sub: string;  // user id
  role: "viewer" | "configurator";
};

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { algorithm: "HS256", expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, SECRET, { algorithms: ["HS256"] }) as JwtPayload;
}
