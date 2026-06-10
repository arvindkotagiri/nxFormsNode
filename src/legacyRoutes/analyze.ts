// @ts-nocheck
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pdfToPng } from 'pdf-to-png-converter';
import { callLLM } from '../utils/llmUtils';

const router = express.Router();
const upload = multer({
  limits: { fileSize: 100 * 1024 * 1024 }
});

const PROMPT_ANALYSIS = `
Analyze this document with extreme precision. 

Return a JSON list of objects. Each object must have:
1. "field_name": snake_case name (e.g., logo, signature, company_name, total_amount).
2. "category": 'static' or 'dynamic'.
3. "content_type": 'text', 'barcode', 'qrcode', 'table', 'logo', or 'signature'.
4. "box_2d": [ymin, xmin, ymax, xmax] coordinates.
5. "value": The original text/content seen in the image for this field.

CRITICAL:
- If you see a logo, identify it as "content_type": "logo".
- If you see a signature, identify it as "content_type": "signature".

CRITICAL INSTRUCTIONS FOR TABLES:
- If a table is present, create ONE object with "content_type": "table".
- The "box_2d" must encompass the ENTIRE table area.
- Inside this object, add "table_data": a list of rows.
- Each row MUST be a LIST of cell objects (consistent column order).
- Each cell: {"value": "the_text", "category": "static" or "dynamic"}
`;

async function getAnnotatedBase64(cleanImgBuffer, extractedData) {
  const metadata = await sharp(cleanImgBuffer).metadata();
  const width = metadata.width;
  const height = metadata.height;

  let svgElements = '';
  for (const item of extractedData) {
    if (!item.box_2d || item.box_2d.length !== 4) continue;
    const [ymin, xmin, ymax, xmax] = item.box_2d.map(Number);
    const left = (xmin * width) / 1000;
    const top = (ymin * height) / 1000;
    const right = (xmax * width) / 1000;
    const bottom = (ymax * height) / 1000;
    const w = right - left;
    const h = bottom - top;

    const isTable = item.content_type === 'table';
    const borderCol = isTable ? 'rgba(34, 197, 94, 1)' : 'rgba(37, 99, 235, 1)';
    const fillCol = isTable ? 'rgba(34, 197, 94, 0.16)' : 'rgba(37, 99, 235, 0.16)';

    svgElements += `<rect x="${left}" y="${top}" width="${w}" height="${h}" fill="${fillCol}" stroke="${borderCol}" stroke-width="4"/>`;

    const displayText = (item.field_name || 'Field').toUpperCase();
    const tagW = displayText.length * 9 + 12;
    const tagTop = Math.max(0, top - 28);
    svgElements += `<rect x="${left}" y="${tagTop}" width="${tagW}" height="28" fill="${borderCol}"/>`;
    svgElements += `<text x="${left + 6}" y="${tagTop + 18}" fill="white" font-family="monospace" font-size="13" font-weight="bold">${displayText}</text>`;
  }

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${svgElements}
    </svg>
  `;

  const annotatedBuffer = await sharp(cleanImgBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();

  return annotatedBuffer.toString('base64');
}

async function cropAndSave(imageBuffer, box_2d, field_name) {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  
  const [ymin, xmin, ymax, xmax] = box_2d.map(Number);
  let left = (xmin * width) / 1000;
  let top = (ymin * height) / 1000;
  let right = (xmax * width) / 1000;
  let bottom = (ymax * height) / 1000;

  const padding = 5;
  left = Math.max(0, left - padding);
  top = Math.max(0, top - padding);
  right = Math.min(width, right + padding);
  bottom = Math.min(height, bottom + padding);

  let extractLeft = Math.round(left);
  let extractTop = Math.round(top);
  let extractWidth = Math.min(width - extractLeft, Math.round(right - left));
  let extractHeight = Math.min(height - extractTop, Math.round(bottom - top));

  if (extractWidth <= 0) extractWidth = 1;
  if (extractHeight <= 0) extractHeight = 1;

  const cropped = await sharp(imageBuffer)
    .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
    .png()
    .toBuffer();

  const tempDir = 'static/temp';
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const filename = `${field_name}_${crypto.randomBytes(4).toString('hex')}.png`;
  const filepath = path.join(tempDir, filename);
  fs.writeFileSync(filepath, cropped);

  const imgStr = cropped.toString('base64');
  return [filepath, `data:image/png;base64,${imgStr}`];
}

router.post('/analyze-label', upload.single('image'), async (req, res) => {
  console.log("\n" + "="*50);
  console.log("[BACKEND] --- LABEL ANALYSIS INITIATED ---");
  console.log("="*50);

  if (!req.file) {
    console.error("[ERROR] No image file found in request");
    return res.status(400).json({ error: "No file" });
  }

  try {
    const fileBytes = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();
    console.log(`[INFO] Analyzing file: ${filename} (${fileBytes.length} bytes)`);

    const allExtractedFields = [];
    const annotatedImages = [];
    const cleanImages = [];

    if (filename.endsWith('.pdf')) {
      console.log("[INFO] Processing PDF file...");
      
      // Render PDF pages as PNG images
      const pngPages = await pdfToPng(fileBytes, { viewportScale: 2.0 });
      const numPages = pngPages.length;
      console.log(`[INFO] PDF has ${numPages} pages.`);

      for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
        console.log(`[INFO] Analyzing page ${pageIdx + 1}/${numPages}...`);
        const pageImgBuffer = pngPages[pageIdx].content;
        
        // Ensure image buffer is standard RGB PNG format for LLM consistency
        const cleanPngBuffer = await sharp(pageImgBuffer).toFormat('png').toBuffer();

        // Call LLM for this page
        const rawResponse = await callLLM(
          'analyze',
          PROMPT_ANALYSIS,
          null,
          cleanPngBuffer,
          "application/json"
        );

        let extractedData = JSON.parse(rawResponse);
        if (extractedData && typeof extractedData === 'object') {
          if (Array.isArray(extractedData.fields)) {
            extractedData = extractedData.fields;
          } else if (Array.isArray(extractedData.data)) {
            extractedData = extractedData.data;
          }
        }

        if (!Array.isArray(extractedData)) {
          extractedData = [];
        }

        // Process crops and tag with page_index
        for (const item of extractedData) {
          item.page_index = pageIdx;
          if (item.content_type === 'logo' || item.content_type === 'signature') {
            try {
              if (item.box_2d && item.box_2d.length === 4) {
                const [filepath, b64Data] = await cropAndSave(cleanPngBuffer, item.box_2d, `${item.content_type}_p${pageIdx}`);
                item.cropped_path = filepath;
                item.cropped_b64 = b64Data;
              }
            } catch (cropErr) {
              console.error(`    [ERROR] Crop Error on page ${pageIdx}: ${cropErr.message}`);
            }
          }
        }

        allExtractedFields.push(...extractedData);

        // Generate previews
        const annotatedB64 = await getAnnotatedBase64(cleanPngBuffer, extractedData);
        
        annotatedImages.push(`data:image/png;base64,${annotatedB64}`);
        cleanImages.push(`data:image/png;base64,${cleanPngBuffer.toString('base64')}`);
      }

      console.log("[SUCCESS] Multi-page PDF analysis complete");
    } else {
      // Single image upload
      console.log("[INFO] Processing image file...");
      
      const cleanPngBuffer = await sharp(fileBytes).png().toBuffer();
      
      const rawResponse = await callLLM(
        'analyze',
        PROMPT_ANALYSIS,
        null,
        cleanPngBuffer,
        "application/json"
      );

      let extractedData = JSON.parse(rawResponse);
      if (extractedData && typeof extractedData === 'object') {
        if (Array.isArray(extractedData.fields)) {
          extractedData = extractedData.fields;
        } else if (Array.isArray(extractedData.data)) {
          extractedData = extractedData.data;
        }
      }

      if (!Array.isArray(extractedData)) {
        extractedData = [];
      }

      for (const item of extractedData) {
        item.page_index = 0;
        if (item.content_type === 'logo' || item.content_type === 'signature') {
          try {
            if (item.box_2d && item.box_2d.length === 4) {
              const [filepath, b64Data] = await cropAndSave(cleanPngBuffer, item.box_2d, item.content_type);
              item.cropped_path = filepath;
              item.cropped_b64 = b64Data;
            }
          } catch (cropErr) {
            console.error(`    [ERROR] Crop Error: ${cropErr.message}`);
          }
        }
      }

      allExtractedFields.push(...extractedData);

      const annotatedB64 = await getAnnotatedBase64(cleanPngBuffer, extractedData);
      
      annotatedImages.push(`data:image/png;base64,${annotatedB64}`);
      cleanImages.push(`data:image/png;base64,${cleanPngBuffer.toString('base64')}`);
    }

    console.log("="*50);
    console.log("[BACKEND] --- ANALYSIS COMPLETE ---");
    console.log("="*50 + "\n");

    res.status(200).json({
      status: "success",
      extracted_fields: allExtractedFields,
      annotated_image: annotatedImages[0],
      clean_image: cleanImages[0],
      annotated_images: annotatedImages,
      clean_images: cleanImages
    });
  } catch (err) {
    console.error("\n[CRITICAL ERROR] Analysis failed:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

