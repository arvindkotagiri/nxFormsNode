// @ts-nocheck
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { pool } from '../db';
import { verifyPassword } from '../utils/password';
import { signToken } from '../utils/jwt';

const router = express.Router();
const upload = multer({
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

export async function initImageDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS image_master (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        size VARCHAR(50),
        resolution VARCHAR(50),
        color BOOLEAN DEFAULT TRUE,
        image_data BYTEA NOT NULL,
        mime_type VARCHAR(50) DEFAULT 'image/png',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("[INIT] image_master table verified/created in database");
  } catch (err) {
    console.error("[INIT ERROR] Failed to initialize image master database:", err);
  }
}

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ detail: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      `SELECT id::text, email, name, first_name, last_name, organization, tenant_id, status, role, password_hash
       FROM users
       WHERE LOWER(email) = LOWER($1)`,
      [email]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ detail: 'Invalid email or password' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ detail: 'Invalid email or password' });

    if (user.status === 'PENDING') {
      return res.status(403).json({ detail: 'Your account is pending approval by an admin.' });
    }

    if (user.status === 'REJECTED') {
      return res.status(403).json({ detail: 'Your account registration was rejected by an admin.' });
    }

    const accessToken = signToken({ sub: user.id, role: user.role });
    return res.status(200).json({
      access_token: accessToken,
      token_type: 'bearer',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        first_name: user.first_name,
        last_name: user.last_name,
        organization: user.organization,
        tenant_id: user.tenant_id,
        status: user.status,
        role: user.role,
      }
    });
  } catch (err) {
    console.error('Legacy image-retention login failed:', err);
    return res.status(500).json({ error: err.message || 'Login failed' });
  }
});

router.get('/image-retention', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, size, resolution, color FROM image_master ORDER BY id DESC");
    const formatted = result.rows.map(r => ({
      id: String(r.id),
      name: r.name,
      size: r.size,
      resolution: r.resolution,
      color: Boolean(r.color)
    }));
    res.status(200).json(formatted);
  } catch (err) {
    console.error("Error fetching images:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/image-retention/metadata', upload.array('images'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No image files in request" });
    }

    const files = req.files;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      for (const file of files) {
        if (!file || !file.originalname) continue;

        let fileBytes = file.buffer;
        const filename = file.originalname;
        
        // Auto-downscale image to a maximum of 600px width/height
        let resolutionStr = "Unknown";
        let colorVal = true;

        try {
          const img = sharp(file.buffer);
          const metadata = await img.metadata();
          
          if (metadata.width > 600 || metadata.height > 600) {
            fileBytes = await img
              .resize({
                width: 600,
                height: 600,
                fit: 'inside',
                kernel: 'lanczos3'
              })
              // Keep original format if possible, otherwise default to PNG
              .toFormat(metadata.format || 'png')
              .toBuffer();
          }

          // Read final resolution and color info from metadata
          const finalImg = sharp(fileBytes);
          const finalMeta = await finalImg.metadata();
          resolutionStr = `${finalMeta.width}x${finalMeta.height}`;
          colorVal = finalMeta.channels > 1;
        } catch (resizeErr) {
          console.warn(`[WARNING] Image processing failed for ${filename}:`, resizeErr.message);
        }

        // Format size string
        const sizeKb = fileBytes.length / 1024.0;
        const sizeStr = sizeKb > 1024.0 ? `${(sizeKb / 1024.0).toFixed(1)} MB` : `${sizeKb.toFixed(1)} KB`;
        const mimeType = file.mimetype || 'image/png';

        const insertQuery = `
          INSERT INTO image_master (name, size, resolution, color, image_data, mime_type)
          VALUES ($1, $2, $3, $4, $5, $6)
        `;
        await client.query(insertQuery, [filename, sizeStr, resolutionStr, colorVal, fileBytes, mimeType]);
      }

      await client.query('COMMIT');
      res.status(201).json({ status: "success", message: "Images imported successfully" });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Error uploading images:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/image-retention/:image_id/image', async (req, res) => {
  const { image_id } = req.params;
  try {
    const result = await pool.query("SELECT image_data, mime_type, name FROM image_master WHERE id = $1", [image_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Image not found" });
    }

    let { image_data, mime_type, name } = result.rows[0];

    // On-the-fly downscaling for existing large database images
    try {
      const img = sharp(image_data);
      const metadata = await img.metadata();
      if (metadata.width > 600 || metadata.height > 600) {
        image_data = await img
          .resize({
            width: 600,
            height: 600,
            fit: 'inside',
            kernel: 'lanczos3'
          })
          .toFormat(metadata.format || 'png')
          .toBuffer();
      }
    } catch (resizeErr) {
      console.warn("[WARNING] On-the-fly downscaling failed:", resizeErr.message);
    }

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.type(mime_type).send(image_data);
  } catch (err) {
    console.error("Error retrieving image file:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/image-retention/:image_id', async (req, res) => {
  const { image_id } = req.params;
  try {
    await pool.query("DELETE FROM image_master WHERE id = $1", [image_id]);
    res.status(200).json({ status: "success", message: "Image deleted successfully" });
  } catch (err) {
    console.error("Error deleting image:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

