// import { Pool } from "pg";
// import dotenv from "dotenv";

// dotenv.config();

// if (!process.env.DATABASE_URL) {
//   throw new Error("DATABASE_URL is not set in .env");
// }

// export const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   // ssl: false // local install typically doesn't need SSL
// });

import { Pool } from "pg";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in .env");
}

// Configure SSL for Postgres. If a CA path is provided via DB_SSL_CA, use it
// and enable strict verification. Otherwise allow explicit DB_SSL=true to enable
// verification without custom CA. If neither is set, SSL is disabled (typical
// for local development).
let sslOption: any = false;
if (process.env.DB_SSL_CA) {
  try {
    const ca = fs.readFileSync(process.env.DB_SSL_CA);
    sslOption = { ca, rejectUnauthorized: true };
  } catch (err) {
    console.error("Failed to read DB_SSL_CA file:", err);
    throw err;
  }
} else if (process.env.DB_SSL === "true") {
  sslOption = { rejectUnauthorized: true };
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslOption,
});