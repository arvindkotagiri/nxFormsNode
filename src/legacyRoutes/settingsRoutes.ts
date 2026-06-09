// @ts-nocheck
import express from 'express';
import { pool } from '../db';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

export async function initSettingsDb() {
  const client = await pool.connect();
  try {
    // 1. Create system_settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Insert defaults if not exist
    const defaults = {
      'model_analyze': 'google:gemini-3.1-pro-preview',
      'model_zpl': 'google:gemini-3.1-pro-preview',
      'model_xdp': 'google:gemini-3.1-pro-preview',
      'model_invoice': 'google:gemini-3.1-pro-preview',
      'api_gemini': process.env.GEMINI_API_KEY || "",
      'api_openai': "",
      'api_anthropic': ""
    };

    for (const [key, val] of Object.entries(defaults)) {
      await client.query(
        "INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
        [key, val]
      );
    }

    // 2. Create label_master
    await client.query(`
      CREATE TABLE IF NOT EXISTS label_master (
        uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label_id TEXT,
        label_name TEXT,
        context TEXT,
        field_mapping JSONB,
        bar_code_type TEXT,
        zpl_code TEXT,
        fields JSONB,
        version NUMERIC,
        created_by TEXT,
        created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add missing columns if they don't exist
    const columnsToAdd = [
      ["html_code", "TEXT"],
      ["page_dimensions", "TEXT"],
      ["output_mode", "TEXT"]
    ];

    for (const [colName, colType] of columnsToAdd) {
      await client.query(`
        DO $$ 
        BEGIN 
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                           WHERE table_name='label_master' AND column_name='${colName}') THEN
                ALTER TABLE label_master ADD COLUMN ${colName} ${colType};
            END IF;
        END $$;
      `);
    }

    console.log("[INIT] System settings and label tables verified/created successfully.");
  } catch (err) {
    console.error("[INIT ERROR] Failed to initialize system settings DB:", err);
  } finally {
    client.release();
  }
}

async function getApiKeyHelper(provider) {
  let lookupProvider = provider;
  if (provider === 'google') {
    lookupProvider = 'gemini';
  }
  const key = `api_${lookupProvider}`;
  try {
    const res = await pool.query("SELECT value FROM system_settings WHERE key = $1", [key]);
    if (res.rows.length > 0 && res.rows[0].value) {
      return res.rows[0].value;
    }
  } catch (err) {
    // ignore
  }
  if (lookupProvider === 'gemini') {
    return process.env.GEMINI_API_KEY || "";
  }
  return "";
}

async function buildModelsList(geminiKey, openaiKey, anthropicKey) {
  const allModels = [];

  // 1. Google Gemini
  if (geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`;
      const response = await axios.get(url, { timeout: 10000 });
      const models = response.data.models || [];
      for (const m of models) {
        const methods = m.supportedGenerationMethods || [];
        if (methods.includes('generateContent') || m.name.toLowerCase().includes('gemini')) {
          const shortName = m.name.replace("models/", "");
          allModels.push({
            "name": `google:${shortName}`,
            "display_name": `Google: ${m.displayName || shortName}`,
            "provider": "google"
          });
        }
      }
    } catch (e) {
      console.error("Gemini Fetch Error:", e.message);
    }
  }

  // 2. OpenAI (static list)
  if (openaiKey) {
    allModels.push(
      { "name": "openai:gpt-4o", "display_name": "OpenAI: GPT-4o", "provider": "openai" },
      { "name": "openai:gpt-4o-mini", "display_name": "OpenAI: GPT-4o-mini", "provider": "openai" },
      { "name": "openai:gpt-3.5-turbo", "display_name": "OpenAI: GPT-3.5 Turbo", "provider": "openai" }
    );
  }

  // 3. Anthropic (static list)
  if (anthropicKey) {
    allModels.push(
      { "name": "anthropic:claude-sonnet-4-6", "display_name": "Anthropic: Claude Sonnet 4.6", "provider": "anthropic" },
      { "name": "anthropic:claude-opus-4-6", "display_name": "Anthropic: Claude Opus 4.6", "provider": "anthropic" },
      { "name": "anthropic:claude-haiku-4-5-20251001", "display_name": "Anthropic: Claude Haiku 4.5", "provider": "anthropic" },
      { "name": "anthropic:claude-sonnet-4-20250514", "display_name": "Anthropic: Claude Sonnet 4 (stable)", "provider": "anthropic" }
    );
  }

  return allModels;
}

router.get('/available-models', async (req, res) => {
  try {
    const geminiKey = (await getApiKeyHelper('gemini')) || process.env.GEMINI_API_KEY || "";
    const openaiKey = await getApiKeyHelper('openai');
    const anthropicKey = await getApiKeyHelper('anthropic');
    const models = await buildModelsList(geminiKey, openaiKey, anthropicKey);
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/available-models', async (req, res) => {
  try {
    const data = req.body || {};
    const geminiKey = data.api_gemini || (await getApiKeyHelper('gemini')) || process.env.GEMINI_API_KEY || "";
    const openaiKey = data.api_openai || (await getApiKeyHelper('openai'));
    const anthropicKey = data.api_anthropic || (await getApiKeyHelper('anthropic'));
    const models = await buildModelsList(geminiKey, openaiKey, anthropicKey);
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/model-configs', async (req, res) => {
  try {
    const query = "SELECT key, value FROM system_settings WHERE key LIKE 'model_%' OR key LIKE 'api_%' OR key LIKE 'agent_%'";
    const result = await pool.query(query);
    const configMap = {};
    for (const row of result.rows) {
      configMap[row.key] = row.value;
    }
    res.json(configMap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/model-configs', async (req, res) => {
  try {
    const data = req.body || {};
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith('model_') || key.startsWith('api_') || key.startsWith('agent_')) {
        await pool.query(
          "INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          [key, val]
        );
      }
    }
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

