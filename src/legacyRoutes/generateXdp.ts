// @ts-nocheck
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { DOMParser } from '@xmldom/xmldom';
import { pdfToPng } from 'pdf-to-png-converter';
import { callLLM } from '../utils/llmUtils';

const router = express.Router();
const upload = multer({
  limits: { fileSize: 100 * 1024 * 1024 }
});

const PROMPT_XDP = `
Role: Expert Adobe Forms Architect.

Task: Convert the attached document image into a valid, well-structured Adobe XDP file. Use the provided HTML_DESIGN as the source of truth if available.
    
    HTML_DESIGN:
    __HTML_DESIGN_PLACEHOLDER__

Instructions:
1. Identify all labels, fields (static and dynamic), and layout structures (containers, subforms) from the image.
2. Ensure logical grouping of fields into subforms based on the visual layout.
3. Use descriptive names for fields (snake_case or camelCase).
4. TEMPLATING: For dynamic data, use the format {{field_name}} (e.g., {{customer_name}}) clearly in the structure instead of hardcoded values.
5. Identify 'brand_logo' [ymin, xmin, ymax, xmax].
6. Identify 'containers' (all shaded bars, borders, or text boxes) [ymin, xmin, ymax, xmax].
7. Extract all text elements with [ymin, xmin, ymax, xmax]. IMPORTANT: For table headers, provide a wide x-range to prevent text wrapping. If text is part of the brand_logo graphic, do not include it in text_elements.
8. Maintain the pixel perfect coordinates of elements like boxes, text elements same as the source document.
9. Generate the XDP XML structure including <template>, <subform>, and field definitions (<field>).
10. Provide a summary of all the Data fields and tables to support building the data provider program.

Return ONLY a JSON object: {
    "xdp_code": "<?xml...<xdp>...</xdp>",
    "data_summary": "Summary of fields and tables..."
}
`;

router.post('/generate-xdp', upload.single('image'), async (req, res) => {
  console.log("\n[BACKEND] --- STARTING XDP ARCHITECTURE GENERATION ---");

  if (!req.file) {
    return res.status(400).json({ error: "No file" });
  }

  try {
    const fileBytes = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();

    let imgBytes;

    if (filename.endsWith('.pdf')) {
      console.log("[INFO] Converting PDF pages to single stacked image for XDP...");
      const pngPages = await pdfToPng(fileBytes, { viewportScale: 3.0 });
      const numPages = pngPages.length;

      const pageImages = [];
      let totalHeight = 0;
      let maxWidth = 0;

      for (const p of pngPages) {
        const cleanPng = await sharp(p.content).png().toBuffer();
        pageImages.push(cleanPng);
        const meta = await sharp(cleanPng).metadata();
        totalHeight += meta.height;
        maxWidth = Math.max(maxWidth, meta.width);
      }

      // Stack PDF pages vertically into a single image buffer using sharp composite
      const compositeList = [];
      let currentY = 0;
      for (const pImg of pageImages) {
        const meta = await sharp(pImg).metadata();
        compositeList.push({
          input: pImg,
          top: currentY,
          left: 0
        });
        currentY += meta.height;
      }

      imgBytes = await sharp({
        create: {
          width: maxWidth,
          height: totalHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      })
      .composite(compositeList)
      .jpeg()
      .toBuffer();
    } else {
      imgBytes = await sharp(fileBytes).jpeg().toBuffer();
    }

    // Clean html_design
    let htmlDesign = req.body.html_design || '';
    if (htmlDesign) {
      htmlDesign = htmlDesign.replace(/data:image\/[^;]+;base64,[^"]+/g, 'IMAGE_PLACEHOLDER');
      htmlDesign = htmlDesign.replace(/<img[^>]*id=["']watermark-element["'][^>]*>/gi, '');
    } else {
      htmlDesign = 'Not provided';
    }

    const promptWithHtml = PROMPT_XDP.replace("__HTML_DESIGN_PLACEHOLDER__", htmlDesign);

    // Call LLM for XDP structure
    const rawResponse = await callLLM(
      'xdp',
      promptWithHtml,
      null,
      imgBytes,
      "application/json"
    );

    const data = JSON.parse(rawResponse);
    const xdpCode = data.xdp_code || '';

    if (!xdpCode) {
      return res.status(500).json({ error: "No XDP code found", raw: rawResponse });
    }

    // Extract layout preview coordinates
    const layoutPreview = [];
    try {
      const doc = new DOMParser().parseFromString(xdpCode, 'text/xml');
      const fields = doc.getElementsByTagName('field');
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        layoutPreview.push({
          name: field.getAttribute('name'),
          x: field.getAttribute('x') || '0',
          y: field.getAttribute('y') || '0',
          w: field.getAttribute('w') || '0',
          h: field.getAttribute('h') || '0'
        });
      }
    } catch (pErr) {
      console.error("XDP Parse Error for Preview:", pErr.message);
    }

    // Replace placeholders with current values for mapping preview
    let previewXdp = xdpCode;
    try {
      const analysisPrompt = "Return JSON list of {'field_name': '...', 'value': '...'}";
      const analysisRes = await callLLM('xdp', analysisPrompt, null, imgBytes, "application/json");
      let fieldData = JSON.parse(analysisRes);
      if (fieldData && typeof fieldData === 'object') {
        if (Array.isArray(fieldData.fields)) fieldData = fieldData.fields;
      }

      if (Array.isArray(fieldData)) {
        for (const item of fieldData) {
          const placeholder = `{{${item.field_name}}}`;
          if (item.value) {
            previewXdp = previewXdp.split(placeholder).join(String(item.value));
          }
        }
      }
    } catch (mapErr) {
      console.error("Mapping Error (XDP):", mapErr.message);
    }

    console.log("[BACKEND] --- XDP GENERATION COMPLETE ---");
    res.status(200).json({
      status: "success",
      xdp_code: xdpCode,
      preview_xdp: previewXdp,
      layout_preview: layoutPreview,
      data_summary: data.data_summary || ''
    });

  } catch (err) {
    console.error("CRITICAL ERROR (XDP):", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

