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

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in .env");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,   // 👈 THIS FIXES IT
  },
});