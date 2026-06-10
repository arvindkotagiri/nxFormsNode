// @ts-nocheck
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import axios from 'axios';
import { pdfToPng } from 'pdf-to-png-converter';
import { callLLM } from '../utils/llmUtils';

const router = express.Router();
const upload = multer({
  limits: { fileSize: 100 * 1024 * 1024 }
});

function cleanZpl(text) {
  const match = text.match(/(\^XA[\s\S]*?\^XZ)/);
  if (match) {
    return match[1].trim();
  }
  return text.replace("```zpl", "").replace("```", "").trim();
}

async function getLabelaryPreview(zplText, widthIn, heightIn, dpmm) {
  const url = `http://api.labelary.com/v1/printers/${dpmm}dpmm/labels/${widthIn}x${heightIn}/0/`;
  try {
    const response = await axios.post(url, zplText, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      responseType: 'arraybuffer',
      timeout: 10000
    });
    if (response.status === 200) {
      return Buffer.from(response.data).toString('base64');
    }
  } catch (err) {
    console.error("Labelary Error:", err.message);
  }
  return null;
}

function getHtmlElementDimensions(htmlStr, fieldName) {
  const imgTags = htmlStr.match(/<img[^>]*>/gi) || [];
  for (const tag of imgTags) {
    const isSig = tag.toLowerCase().includes('signature');
    const isWm = tag.includes('watermark-element');
    
    if (fieldName === 'signature' && !isSig) continue;
    if (fieldName === 'logo' && (isSig || isWm)) continue;
    
    const wMatch = tag.match(/width:\s*([0-9.]+)px/i) || tag.match(/width=["']([0-9.]+)["']/i);
    const hMatch = tag.match(/height:\s*([0-9.]+)px/i) || tag.match(/height=["']([0-9.]+)["']/i);
    
    if (wMatch && hMatch) {
      try {
        return [Math.round(parseFloat(wMatch[1])), Math.round(parseFloat(hMatch[1]))];
      } catch (err) {
        // ignore
      }
    }
  }
  return null;
}

async function getZplGraphic(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .grayscale()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const widthBytes = Math.floor((width + 7) / 8);
  const totalBytes = widthBytes * height;
  const outputBuffer = Buffer.alloc(totalBytes);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelVal = data[y * width + x];
      // In PIL's "1" conversion: 0 is black (ZPL prints 1 for black), 1 is white.
      // So we set the bit to 1 if it is white, 0 if black.
      const bit = pixelVal >= 128 ? 1 : 0;
      
      const byteIdx = y * widthBytes + Math.floor(x / 8);
      const bitIdx = 7 - (x % 8);
      if (bit) {
        outputBuffer[byteIdx] |= (1 << bitIdx);
      }
    }
  }
  const hexData = outputBuffer.toString('hex').toUpperCase();
  return `^GFA,${totalBytes},${totalBytes},${widthBytes},${hexData}`;
}

async function cropParts(pageImageBuffer, widthIn, dpi, htmlDesign) {
  const promptFind = "Return JSON list of objects: {'field_name': 'logo'|'signature', 'box_2d': [ymin, xmin, ymax, xmax]}";
  try {
    const res = await callLLM('zpl', promptFind, null, pageImageBuffer, "application/json");
    let items = JSON.parse(res);
    if (items && typeof items === 'object') {
      if (Array.isArray(items.fields)) items = items.fields;
      else if (Array.isArray(items.data)) items = items.data;
    }

    if (!Array.isArray(items)) {
      return {};
    }

    const crops = {};
    const metadata = await sharp(pageImageBuffer).metadata();
    const w = metadata.width;
    const h = metadata.height;
    const scaleFactor = (widthIn * dpi) / 816.0;

    for (const it of items) {
      const box = it.box_2d;
      const fieldName = it.field_name || it.label;
      if (box && box.length === 4 && fieldName) {
        const [ymin, xmin, ymax, xmax] = box.map(Number);
        const left = (xmin * w) / 1000;
        const top = (ymin * h) / 1000;
        const right = (xmax * w) / 1000;
        const bottom = (ymax * h) / 1000;

        let extractLeft = Math.round(left);
        let extractTop = Math.round(top);
        let extractWidth = Math.min(w - extractLeft, Math.round(right - left));
        let extractHeight = Math.min(h - extractTop, Math.round(bottom - top));

        if (extractWidth <= 0) extractWidth = 1;
        if (extractHeight <= 0) extractHeight = 1;

        let cropBuffer = await sharp(pageImageBuffer)
          .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
          .png()
          .toBuffer();

        const dims = getHtmlElementDimensions(htmlDesign, fieldName);
        if (dims) {
          const targetW = Math.round(dims[0] * scaleFactor);
          const targetH = Math.round(dims[1] * scaleFactor);
          if (targetW > 0 && targetH > 0) {
            cropBuffer = await sharp(cropBuffer)
              .resize(targetW, targetH, { fit: 'fill', kernel: 'lanczos3' })
              .png()
              .toBuffer();
          }
        }
        
        crops[fieldName] = await getZplGraphic(cropBuffer);
      }
    }
    return crops;
  } catch (err) {
    console.warn("[WARNING] cropParts failed:", err.message);
    return {};
  }
}

router.post('/generate-zpl', upload.single('image'), async (req, res) => {
  console.log("\n[BACKEND] --- STARTING ZPL CODE GENERATION ---");

  const widthIn = parseFloat(req.body.width || 4);
  const heightIn = parseFloat(req.body.height || 6);
  const dpi = parseInt(req.body.dpi || 203, 10);
  const dpmm = dpi < 300 ? 8 : 12;

  let htmlDesign = req.body.html_design || '';
  if (htmlDesign) {
    htmlDesign = htmlDesign.replace(/data:image\/[^;]+;base64,[^"]+/g, 'IMAGE_PLACEHOLDER');
    htmlDesign = htmlDesign.replace(/<img[^>]*id=["']watermark-element["'][^>]*>/gi, '');
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    const fileBytes = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();

    const pageImages = [];

    if (filename.endsWith('.pdf')) {
      console.log("[INFO] Converting PDF to images page by page for ZPL...");
      const pngPages = await pdfToPng(fileBytes, { viewportScale: 3.0 });
      for (const p of pngPages) {
        const cleanPng = await sharp(p.content).png().toBuffer();
        pageImages.push(cleanPng);
      }
    } else {
      const cleanPng = await sharp(fileBytes).png().toBuffer();
      const metadata = await sharp(cleanPng).metadata();
      const width = metadata.width;
      const height = metadata.height;
      const pageHeight = Math.round(width * (11 / 8.5));
      const numPages = Math.max(1, Math.round(height / pageHeight));
      
      console.log(`[INFO] Image height is ${height}, pageHeight calculated as ${pageHeight}. Detected ${numPages} pages.`);

      for (let i = 0; i < numPages; i++) {
        const top = i * pageHeight;
        const bottom = Math.min(height, (i + 1) * pageHeight);
        const pageHeightReal = bottom - top;
        if (pageHeightReal > 0) {
          const cropped = await sharp(cleanPng)
            .extract({ left: 0, top: top, width: width, height: pageHeightReal })
            .png()
            .toBuffer();
          pageImages.push(cropped);
        }
      }
    }

    const zplPrompt = `
    ACT AS A ZPL EXPERT.
    Convert the attached label image into valid ZPL II code.
    
    If an HTML_DESIGN is provided below, use it as the ABSOLUTE source of truth for positions, dimensions, and text content.
    
    HTML_DESIGN:
    ${htmlDesign || 'Not provided'}
    
    SPECS:
    - Target DPI: ${dpi} (${dpmm} dpmm)
    - Label Size: ${widthIn}" x ${heightIn}"
    
    RULES:
    1. Use ^FB for multi-line text blocks.
    2. Use ^GB for boxes and separators.
    3. For Barcodes: Use ^BC (Code 128) or ^BX (Data Matrix) as seen in image.
    4. Return ONLY the code starting with ^XA and ending with ^XZ.
    5. DO NOT include markdown or explanations.
    6. If there is a LOGO, use the placeholder ^GF_LOGO_PLACEHOLDER.
    7. If there is a SIGNATURE, use the placeholder ^GF_SIGNATURE_PLACEHOLDER.
    8. If there is a LOGO, use the placeholder ^GF_LOGO_PLACEHOLDER.
    9. If there is a SIGNATURE, use the placeholder ^GF_SIGNATURE_PLACEHOLDER.
    10. TEMPLATING (STRICT RULE - DO NOT IGNORE):
        - ANY text that looks like variable data MUST be replaced with placeholders.
        - DO NOT include actual values.
        - Use ONLY placeholders like:
        {{CheckDate}}, {{VendorName}}, {{Amount}}, {{CheckNumber}}, {{AmountInWords}}, {{VendorAddress1}}
        - Example:
        WRONG: ^FDSep/25/2023^FS
        CORRECT: ^FD{{CheckDate}}^FS
    `;

    const zplBlocks = [];
    const previewZpls = [];
    const labelaryPreviews = [];

    for (let pageIdx = 0; pageIdx < pageImages.length; pageIdx++) {
      console.log(`[INFO] Generating ZPL for page ${pageIdx + 1}/${pageImages.length}...`);
      const pImg = pageImages[pageIdx];

      const rawZpl = await callLLM('zpl', zplPrompt, null, pImg, "text/plain");
      let zplCode = cleanZpl(rawZpl);

      if (!zplCode) {
        console.warn(`[WARNING] AI failed to generate ZPL for page ${pageIdx + 1}`);
        continue;
      }

      // Replace placeholders
      const cropsZpl = await cropParts(pImg, widthIn, dpi, htmlDesign);
      
      if (cropsZpl.logo) {
        zplCode = zplCode.replace('^GF_LOGO_PLACEHOLDER', cropsZpl.logo);
      } else {
        zplCode = zplCode.replace('^GF_LOGO_PLACEHOLDER', '');
      }

      if (cropsZpl.signature) {
        zplCode = zplCode.replace('^GF_SIGNATURE_PLACEHOLDER', cropsZpl.signature);
      } else {
        zplCode = zplCode.replace('^GF_SIGNATURE_PLACEHOLDER', '');
      }

      zplBlocks.push(zplCode);

      // Preview mapping
      let previewZpl = zplCode;
      try {
        const analysisPrompt = "Return JSON list of {'field_name': '...', 'value': '...'}";
        const analysisRes = await callLLM('zpl', analysisPrompt, null, pImg, "application/json");
        let fieldData = JSON.parse(analysisRes);
        if (fieldData && typeof fieldData === 'object') {
          if (Array.isArray(fieldData.fields)) fieldData = fieldData.fields;
        }

        if (Array.isArray(fieldData)) {
          for (const item of fieldData) {
            const placeholder = `{{${item.field_name}}}`;
            if (item.value) {
              previewZpl = previewZpl.split(placeholder).join(String(item.value));
            }
          }
        }
      } catch (mapErr) {
        console.error(`Mapping Error (ZPL Page ${pageIdx}):`, mapErr.message);
      }

      previewZpls.push(previewZpl);

      const previewB64 = await getLabelaryPreview(previewZpl, widthIn, heightIn, dpmm);
      if (previewB64) {
        labelaryPreviews.push(`data:image/png;base64,${previewB64}`);
      }
    }

    const fullZpl = zplBlocks.join('\n');
    const fullPreviewZpl = previewZpls.join('\n');

    console.log("[BACKEND] --- ZPL GENERATION COMPLETE ---");
    
    res.status(200).json({
      status: "success",
      zpl_code: fullZpl,
      labelary_preview: labelaryPreviews[0] || null,
      labelary_previews: labelaryPreviews,
      preview_zpl: fullPreviewZpl
    });

  } catch (err) {
    console.error("Server Error (ZPL):", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

