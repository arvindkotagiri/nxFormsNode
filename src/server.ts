// Polyfill process.getBuiltinModule for Node 18 compatibility with pdfjs-dist
if (typeof process !== "undefined" && !(process as any).getBuiltinModule) {
  (process as any).getBuiltinModule = function (name: string) {
    try {
      return require(name);
    } catch (e) {
      return undefined;
    }
  };
}

// Polyfill browser globals for pdfjs-dist in Node.js
// @ts-ignore
import DOMMatrix from 'dommatrix';
(globalThis as any).DOMMatrix = DOMMatrix;

if (!(globalThis as any).ImageData) {
  (globalThis as any).ImageData = class ImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    constructor(width: number, height: number, data?: Uint8ClampedArray) {
      this.width = width;
      this.height = height;
      this.data = data || new Uint8ClampedArray(width * height * 4);
    }
  };
}

if (!(globalThis as any).Path2D) {
  (globalThis as any).Path2D = class Path2D {
    addPath() {}
    closePath() {}
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    arcTo() {}
    ellipse() {}
    rect() {}
  };
}

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
import imageRetentionRoutes from "./routes/imageRetention";
import settingsRoutes, { initSettingsDb } from "./legacyRoutes/settingsRoutes";
import dbRoutes from "./legacyRoutes/dbRoutes";
import labelRoutes from "./legacyRoutes/labelRoutes";
import analyzeRoutes from "./legacyRoutes/analyze";
import generateZplRoutes from "./legacyRoutes/generateZpl";
import generateXdpRoutes from "./legacyRoutes/generateXdp";
import replicateInvoiceRoutes from "./legacyRoutes/replicateInvoice";
import apiMasterRoutes from "./legacyRoutes/apiMasterRoutes";
import printerRoutes from "./legacyRoutes/printerRoutes";
import legacyImageRetentionRoutes, { initImageDb } from "./legacyRoutes/imageRetentionRoutes";
import { ensureAuditColumns } from "./db/ensureAuditColumns";
import { initApiCatalogDb } from "./db/initApiCatalogDb";
import https from 'https';
import fs from 'fs';
import path from "path";


dotenv.config();

const app = express();
const staticDir = path.resolve(process.cwd(), "static");
const spaIndexPath = path.join(staticDir, "index.html");

app.use(
  cors({
    origin: "*", // Allow any origin
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false, // must be false if origin is "*"
  })
);
app.options(/.*/, cors());

app.use(express.static(staticDir));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use("/auth", authRoutes);
app.use("/api/auth", authRoutes);
app.use("/reference", referenceRoutes);
app.use("/api/reference", referenceRoutes);
app.use("/label-configs", labelConfigRoutes);
app.use("/api/label-configs", labelConfigRoutes);
app.use("/label-determination", determinationRoutes);
app.use("/api/label-determination", determinationRoutes);
app.use("/events", eventsRoutes);
app.use("/api/events", eventsRoutes);
app.use("/outputs", outputsRoutes);
app.use("/api/outputs", outputsRoutes);
app.use("/logs", logsRoutes);
app.use("/api/logs", logsRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/contexts", contextsRoutes);
app.use("/api/contexts", contextsRoutes);
app.use("/simulation", simulationRoutes);
app.use("/api/simulation", simulationRoutes);
app.use("/image-retention", imageRetentionRoutes);
app.use("/api/image-retention", imageRetentionRoutes);
app.use("/", dbRoutes);
app.use("/", labelRoutes);
app.use("/", settingsRoutes);
app.use("/", analyzeRoutes);
app.use("/", generateZplRoutes);
app.use("/", generateXdpRoutes);
app.use("/", replicateInvoiceRoutes);
app.use("/api", apiMasterRoutes);
app.use("/api", printerRoutes);
app.use("/api", legacyImageRetentionRoutes);

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

const apiRoutePrefixes = [
  "/api",
  "/auth",
  "/reference",
  "/label-configs",
  "/label-determination",
  "/events",
  "/outputs",
  "/logs",
  "/dashboard",
  "/contexts",
  "/simulation",
  "/image-retention",
  "/health",
];

// Serve SPA index on deep-link refreshes, while leaving API paths untouched.
app.get(/.*/, (req, res, next) => {
  if (!req.accepts("html")) return next();

  const isApiPath = apiRoutePrefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  if (isApiPath) return next();

  if (!fs.existsSync(spaIndexPath)) return next();
  return res.sendFile(spaIndexPath);
});

const port = Number(process.env.PORT || 4000);

async function startServer() {
  try {
    await initSettingsDb();
    await initImageDb();
    await ensureAuditColumns();
    await initApiCatalogDb();

    if (process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
      const options = {
        key: fs.readFileSync(process.env.SSL_KEY_PATH),
        cert: fs.readFileSync(process.env.SSL_CERT_PATH),
      };
      https.createServer(options, app).listen(443, () => {
        console.log('API running on https://localhost:443');
      });
    } else {
      app.listen(port, () => {
        console.log(`API running on http://localhost:${port}`);
      });
    }
  } catch (err) {
    console.error("[CRITICAL ERROR] Failed to initialize backend:", err);
    process.exit(1);
  }
}

startServer();
