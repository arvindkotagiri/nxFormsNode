import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool } from "./db";
import authRoutes from "./routes/auth";
import labelConfigRoutes from "./routes/labelConfigs";
import determinationRoutes from "./routes/determination";
import referenceRoutes from "./routes/reference";


dotenv.config();

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:5173", // Vite
      "http://127.0.0.1:5173",
      "http://localhost:3000", // if you ever use CRA
      "http://localhost:8080",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true, // ok even if you don't use cookies
  })
);
app.options(/.*/, cors());


app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/reference", referenceRoutes);
app.use("/api/label-configs", labelConfigRoutes);
app.use("/api/label-determination", determinationRoutes);


const allowedOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
    credentials: true,
  })
);

// Health check (matches your FastAPI /api/health)
app.get("/api/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT now() as now");
    res.json({ status: "healthy", timestamp: r.rows[0].now });
  } catch (err: any) {
    res.status(500).json({ status: "unhealthy", error: err?.message || "db error" });
  }
});

app.get("/api", (_req, res) => {
  res.json({ message: "Label Configuration & Determination API", version: "1.0.0" });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
