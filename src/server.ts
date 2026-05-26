import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool } from "./db";
import authRoutes from "./routes/auth";
import labelConfigRoutes from "./routes/labelConfigs";
import determinationRoutes from "./routes/determination";
import referenceRoutes from "./routes/reference";
import eventsRoutes from "./routes/events";
import outputsRoutes from "./routes/outputs";
import logsRoutes from "./routes/logsRoutes";
import dashboardRoutes from "./routes/dashboard";
import contextsRoutes from "./routes/contexts";
import simulationRoutes from "./routes/simulation";


dotenv.config();

const app = express();

app.use(
  cors({
    origin: "*", // Allow any origin
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false, // must be false if origin is "*"
  })
);
app.options(/.*/, cors());


app.use(express.json());
app.use("/auth", authRoutes);
app.use("/reference", referenceRoutes);
app.use("/label-configs", labelConfigRoutes);
app.use("/label-determination", determinationRoutes);
app.use("/events", eventsRoutes);
app.use("/outputs", outputsRoutes);
app.use("/logs", logsRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/contexts", contextsRoutes);
app.use("/simulation", simulationRoutes);

// Health check (matches your FastAPI /health)
app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT now() as now");
    res.json({ status: "healthy", timestamp: r.rows[0].now });
  } catch (err: any) {
    res.status(500).json({ status: "unhealthy", error: err?.message || "db error" });
  }
});

app.get("/", (_req, res) => {
  res.json({ message: "Label Configuration & Determination API", version: "1.0.0" });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
