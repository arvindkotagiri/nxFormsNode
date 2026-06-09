// @ts-nocheck
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { pdfToPng } from 'pdf-to-png-converter';
import { callLLM } from '../utils/llmUtils';

const router = express.Router();
const upload = multer({
  limits: { fileSize: 100 * 1024 * 1024 }
});

const PROMPT_PRECISION = `
Role: Expert Screenshot-to-Code Engineer.
Task: Generate a PIXEL-PERFECT HTML replica of the attached image.

STRICT REQUIREMENTS:
1. DIMENSIONS: Use a fixed container of 816px (width) by 1056px (height). This is exactly 8.5in x 11in at 96DPI.
2. POSITIONING: Every single element (text, line, image) MUST use \`position: absolute\`.
3. COORDINATES: Use \`px\` values for \`top\`, \`left\`, \`width\`, \`height\`, \`font-size\`, and \`line-height\`. Do NOT use percentages.
4. STYLING: Use Tailwind CSS classes where possible, but use inline \`style="..."\` for precise pixel positioning and dimensions.
5. FONT ACCURACY: Match the font weight and size exactly. If a text is 12px and bold, use \`text-[12px] font-bold\`.
6. BORDERS & LINES: Horizontal and vertical lines must be 1px or 2px divs with a background color that matches the document.
7. ASSETS: 
   - <img src="LOGO_PLACEHOLDER" style="position: absolute; ...">
   - <img src="SIGNATURE_PLACEHOLDER" style="position: absolute; ...">
   - <img src="BARCODE_PLACEHOLDER" alt="Barcode" style="position: absolute; ..."> (Use BARCODE_PLACEHOLDER, or BARCODE_PLACEHOLDER_1, BARCODE_PLACEHOLDER_2 if there are multiple barcodes)
   - <img src="QRCODE_PLACEHOLDER" alt="QR Code" style="position: absolute; ..."> (Use QRCODE_PLACEHOLDER, or QRCODE_PLACEHOLDER_1, QRCODE_PLACEHOLDER_2 if there are multiple QR codes)

8. BARCODES & QR CODES: Do NOT represent barcodes as collections of individual line divs, and do NOT represent QR codes as collections of grid cells or table columns. You MUST represent them strictly as absolute-positioned \`<img>\` tags using BARCODE_PLACEHOLDER or QRCODE_PLACEHOLDER as their \`src\`.

TEMPLATE FIELDS:
Replace all dynamic text with {{fieldName}} while keeping the exact position and style of the original text.

EXECUTION:
- Imagine a grid of 816x1056 pixels over the image.
- Map every visual element to its exact X/Y coordinate.
- The output must pass a visual overlay test.

Return ONLY a JSON object: {"full_invoice_html": "<div style='position: relative; width: 816px; height: 1056px; background: white;'>...</div>"}
`;

function stripHtmlWrappers(html) {
  const match = html.match(/<div.*?>.*<\/div>/is);
  if (match) {
    return match[0];
  }
  let cleaned = html.replace(/<(?:html|body|!doctype|head)[^>]*>/gi, '');
  cleaned = cleaned.replace(/<\/(?:html|body|head)>/gi, '');
  return cleaned.trim();
}

function buildPlaceholderPromptBlock(fieldMappings) {
  if (!fieldMappings || Object.keys(fieldMappings).length === 0) {
    return "";
  }

  const lines = [];
  for (const [label, sapPath] of Object.entries(fieldMappings)) {
    if (!label || !sapPath) continue;
    const fieldName = sapPath.includes('.') ? sapPath.split('.').pop() : sapPath;
    lines.push(`  - Text label "${label}" → use placeholder {{${fieldName}}}`);
  }

  if (lines.length === 0) return "";

  return (
    "\n\nFIELD PLACEHOLDER DICTIONARY (MANDATORY — DO NOT DEVIATE):\n" +
    "The following visible text labels appear in the image. For each one, you MUST use " +
    "EXACTLY the placeholder name shown below — do NOT invent your own names, do NOT " +
    "paraphrase, do NOT add prefixes or suffixes:\n" +
    lines.join('\n') +
    "\n\nFor any other dynamic fields not listed above, invent a descriptive {{camelCaseName}}."
  );
}

function applyAssetReplacements(htmlContent, crops) {
  const imgTags = htmlContent.match(/<img[^>]*>/gi) || [];

  const logosFound = [];
  const signaturesFound = [];
  const barcodesFound = [];
  const qrcodesFound = [];

  for (const tag of imgTags) {
    const srcMatch = tag.match(/src=["']([^"']*)["']/i);
    const altMatch = tag.match(/alt=["']([^"']*)["']/i);
    const idMatch = tag.match(/id=["']([^"']*)["']/i);
    const styleMatch = tag.match(/style=["']([^"']*)["']/i);

    const src = srcMatch ? srcMatch[1] : "";
    const alt = altMatch ? altMatch[1] : "";
    const imgId = idMatch ? idMatch[1] : "";
    const style = styleMatch ? styleMatch[1] : "";

    const isWatermark = src.toLowerCase().includes("watermark") || imgId.toLowerCase().includes("watermark") || alt.toLowerCase().includes("watermark");
    if (isWatermark) continue;

    let isLogo = src.toLowerCase().includes("logo") || alt.toLowerCase().includes("logo") || imgId.toLowerCase().includes("logo") || src.toLowerCase().includes("logo_placeholder");
    let isSig = src.toLowerCase().includes("signature") || alt.toLowerCase().includes("signature") || imgId.toLowerCase().includes("signature") || src.toLowerCase().includes("signature_placeholder");
    
    let isBarcode = src.toLowerCase().includes("barcode") || alt.toLowerCase().includes("barcode") || imgId.toLowerCase().includes("barcode") || src.toLowerCase().includes("barcode_placeholder") || tag.toLowerCase().includes("barcode");
    let isQrcode = src.toLowerCase().includes("qrcode") || src.toLowerCase().includes("qr_code") || src.toLowerCase().includes("qr") || alt.toLowerCase().includes("qrcode") || imgId.toLowerCase().includes("qrcode") || tag.toLowerCase().includes("qrcode");

    const topMatch = style.match(/top:\s*([0-9.-]+)px/i);
    const topVal = topMatch ? parseFloat(topMatch[1]) : 0.0;

    if (!isLogo && src.toLowerCase().includes("logo")) isLogo = true;
    if (!isSig && src.toLowerCase().includes("signature")) isSig = true;

    if (isBarcode) {
      barcodesFound.push({ tag, top: topVal });
    } else if (isQrcode) {
      qrcodesFound.push({ tag, top: topVal });
    } else if (isSig) {
      signaturesFound.push({ tag, top: topVal });
    } else if (isLogo || tag.toLowerCase().includes("logo") || src.toLowerCase().includes("logo")) {
      logosFound.push({ tag, top: topVal });
    }
  }

  barcodesFound.sort((a, b) => a.top - b.top);
  qrcodesFound.sort((a, b) => a.top - b.top);
  signaturesFound.sort((a, b) => a.top - b.top);
  logosFound.sort((a, b) => a.top - b.top);

  const barcodeCrops = Object.entries(crops).filter(([k]) => k.toLowerCase().includes("barcode")).sort((a, b) => a[0].localeCompare(b[0]));
  const qrcodeCrops = Object.entries(crops).filter(([k]) => k.toLowerCase().includes("qrcode") || k.toLowerCase().includes("qr_code")).sort((a, b) => a[0].localeCompare(b[0]));
  const signatureCrops = Object.entries(crops).filter(([k]) => k.toLowerCase().includes("signature")).sort((a, b) => a[0].localeCompare(b[0]));
  const logoCrops = Object.entries(crops).filter(([k]) => k.toLowerCase().includes("logo")).sort((a, b) => a[0].localeCompare(b[0]));

  const performReplacement = (foundList, cropList) => {
    foundList.forEach((item, idx) => {
      const tag = item.tag;
      let cropVal = idx < cropList.length ? cropList[idx][1] : (cropList.length > 0 ? cropList[0][1] : null);
      if (cropVal) {
        if (cropVal.startsWith('data:')) {
          cropVal = cropVal.split(',')[1];
        }
        let newTag = tag.replace(/src=["']([^"']*)["']/i, `src="data:image/png;base64,${cropVal}"`);
        if (!newTag.includes('data-editor-element')) {
          newTag = newTag.replace('<img', '<img data-editor-element="true"');
        }
        htmlContent = htmlContent.replace(tag, newTag);
      }
    });
  };

  performReplacement(barcodesFound, barcodeCrops);
  performReplacement(qrcodesFound, qrcodeCrops);
  performReplacement(signaturesFound, signatureCrops);
  performReplacement(logosFound, logoCrops);

  for (let [k, v] of Object.entries(crops)) {
    if (v) {
      if (v.startsWith('data:')) v = v.split(',')[1];
      const b64Src = `data:image/png;base64,${v}`;
      const searchTerms = [
        `${k.toUpperCase()}_PLACEHOLDER`,
        `${k.toUpperCase()}_PLACEHOLDER_1`,
        `${k.toUpperCase()}_1_PLACEHOLDER`
      ];
      for (const term of searchTerms) {
        htmlContent = htmlContent.split(term).join(b64Src);
      }
    }
  }

  return htmlContent;
}

async function cropImageParts(pageImageBuffer) {
  const promptFindCrops = `
  Identify the bounding boxes for 'logo', 'signature', any barcodes, and any QR codes in this document.
  Return a JSON list of objects: {"field_name": "logo"|"signature"|"barcode"|"barcode_1"|"barcode_2"|"qrcode"|"qrcode_1"|"qrcode_2", "box_2d": [ymin, xmin, ymax, xmax]}
  `;
  try {
    const res = await callLLM('invoice', promptFindCrops, null, pageImageBuffer, "application/json");
    let items = JSON.parse(res);
    if (items && typeof items === 'object') {
      if (Array.isArray(items.fields)) items = items.fields;
      else if (Array.isArray(items.data)) items = items.data;
    }

    if (!Array.isArray(items)) {
      console.warn("[WARNING] Expected items list in cropImageParts, got:", typeof items);
      return {};
    }

    const crops = {};
    const metadata = await sharp(pageImageBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;

    for (const item of items) {
      try {
        if (!item || typeof item !== 'object') continue;
        const name = item.field_name || item.label;
        let box = item.box_2d;
        if (name && box) {
          if (Array.isArray(box) && box.length === 1 && Array.isArray(box[0])) {
            box = box[0];
          }
          if (!Array.isArray(box) || box.length !== 4) {
            console.warn(`[WARNING] Invalid crop box for '${name}':`, box);
            continue;
          }

          const [ymin, xmin, ymax, xmax] = box.map(Number);
          let left = (xmin * width) / 1000;
          let top = (ymin * height) / 1000;
          let right = (xmax * width) / 1000;
          let bottom = (ymax * height) / 1000;

          const p = 10;
          let extractLeft = Math.round(Math.max(0, left - p));
          let extractTop = Math.round(Math.max(0, top - p));
          let extractWidth = Math.min(width - extractLeft, Math.round((right + p) - (left - p)));
          let extractHeight = Math.min(height - extractTop, Math.round((bottom + p) - (top - p)));

          if (extractWidth <= 0) extractWidth = 1;
          if (extractHeight <= 0) extractHeight = 1;

          const cropped = await sharp(pageImageBuffer)
            .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
            .png()
            .toBuffer();

          crops[name] = cropped.toString('base64');
        }
      } catch (itemErr) {
        console.warn(`[WARNING] Error processing item crop '${JSON.stringify(item)}':`, itemErr.message);
      }
    }
    return crops;
  } catch (err) {
    console.warn("[WARNING] cropImageParts LLM call or JSON parsing failed:", err.message);
    return {};
  }
}

router.post('/replicate-invoice', upload.single('image'), async (req, res) => {
  console.log("\n" + "="*50);
  console.log("[BACKEND] --- REPLICA GENERATION (HTML) INITIATED ---");
  console.log("="*50);

  if (!req.file) {
    console.error("[ERROR] No image file found in request");
    return res.status(400).json({ error: "No file" });
  }

  try {
    const fileBytes = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();
    console.log(`[INFO] Processing file: ${filename} (${fileBytes.length} bytes)`);

    const isPdf = filename.endsWith('.pdf');
    let logoB64 = req.body.logo_b64;
    let signatureB64 = req.body.signature_b64;

    if (isPdf) {
      console.log("[INFO] Converting PDF to images page by page...");
      const pngPages = await pdfToPng(fileBytes, { viewportScale: 3.0 });
      const numPages = pngPages.length;
      console.log(`[INFO] PDF has ${numPages} pages.`);

      const pageHtmls = [];

      for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
        console.log(`[INFO] Rendering page ${pageIdx + 1}/${numPages}...`);
        const pageImgBuffer = pngPages[pageIdx].content;
        const cleanJpeg = await sharp(pageImgBuffer).jpeg().toBuffer();

        // Generate HTML for this page
        console.log(`[INFO] Sending page ${pageIdx + 1} request to LLM...`);
        const rawResponse = await callLLM(
          'invoice',
          PROMPT_PRECISION,
          null,
          cleanJpeg,
          "application/json"
        );
        console.log(`[SUCCESS] Page ${pageIdx + 1} replica received`);

        try {
          const data = JSON.parse(rawResponse);
          const htmlContent = data.full_invoice_html || (Array.isArray(data) ? data[0].full_invoice_html : '');
          if (htmlContent) {
            const stripped = stripHtmlWrappers(htmlContent);
            pageHtmls.push({ pageIdx, htmlContent: stripped, jpegBytes: cleanJpeg });
          }
        } catch (jsonErr) {
          console.error(`[ERROR] Failed to parse page ${pageIdx + 1} JSON:`, jsonErr.message);
        }
      }

      if (pageHtmls.length === 0) {
        return res.status(500).json({ error: "Failed to generate HTML for any page" });
      }

      // Combine page blocks into a single wrapper
      let combinedHtml = '<div class="multi-page-container" style="display: flex; flex-direction: column; gap: 20px; background: #f1f5f9; padding: 20px;">';
      for (const { pageIdx, htmlContent, jpegBytes } of pageHtmls) {
        let localHtml = htmlContent;

        // Crop assets from this specific page
        const backendCrops = await cropImageParts(jpegBytes);
        
        if (logoB64) backendCrops.logo = logoB64;
        if (signatureB64) backendCrops.signature = signatureB64;

        localHtml = applyAssetReplacements(localHtml, backendCrops);

        combinedHtml += `
        <div class="pdf-page-wrapper" data-page-index="${pageIdx}" style="position: relative; width: 816px; height: 1056px; background: white; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); margin: 0 auto; page-break-after: always;">
            ${localHtml}
        </div>
        `;
      }
      combinedHtml += '</div>';

      const htmlResult = combinedHtml;
      let previewHtml = combinedHtml;

      // Preview substitution based on first page values
      const firstPageBytes = pageHtmls[0].jpegBytes;
      try {
        const analysisPrompt = "Return JSON list of {'field_name': '...', 'value': '...'}";
        const analysisRes = await callLLM('invoice', analysisPrompt, null, firstPageBytes, "application/json");
        let fieldData = JSON.parse(analysisRes);
        if (fieldData && typeof fieldData === 'object') {
          if (Array.isArray(fieldData.fields)) fieldData = fieldData.fields;
        }

        if (Array.isArray(fieldData)) {
          for (const item of fieldData) {
            const placeholder = `{{${item.field_name}}}`;
            if (item.value) {
              previewHtml = previewHtml.split(placeholder).join(String(item.value));
            }
          }
        }
      } catch (mapErr) {
        console.warn("[WARNING] Preview mapping failed on multi-page PDF:", mapErr.message);
      }

      console.log("=" * 50);
      console.log("[BACKEND] --- REPLICA GENERATION COMPLETE (PDF) ---");
      console.log("=" * 50 + "\n");

      return res.status(200).json({
        status: "success",
        full_html: htmlResult,
        preview_html: previewHtml
      });
    } else {
      // Single image processing
      console.log("[INFO] Processing image file...");
      const imgBytes = await sharp(fileBytes).jpeg().toBuffer();
      console.log("[SUCCESS] Image prepared for LLM");

      const rawMappings = req.body.field_mappings || '{}';
      let fieldMappings = {};
      try {
        fieldMappings = JSON.parse(rawMappings);
        if (fieldMappings && Object.keys(fieldMappings).length > 0) {
          console.log(`[INFO] Received ${Object.keys(fieldMappings).length} field mapping(s):`);
          for (const [k, v] of Object.entries(fieldMappings)) {
            const fieldName = v.includes('.') ? v.split('.').pop() : v;
            console.log(`       Label ${k}  →  SAP ${v}  →  placeholder {{${fieldName}}}`);
          }
        } else {
          console.log("[INFO] No field mappings — LLM placeholder names kept as-is");
        }
      } catch (parseErr) {
        console.warn("[WARNING] Could not parse field_mappings JSON:", parseErr.message);
      }

      const placeholderBlock = buildPlaceholderPromptBlock(fieldMappings);
      const promptWithMappings = PROMPT_PRECISION + placeholderBlock;

      if (placeholderBlock) {
        console.log(`[INFO] Injected ${Object.keys(fieldMappings).length} placeholder mapping(s) into prompt`);
      }

      console.log("[INFO] Sending request to LLM (Pixel-Perfect Replica)...");
      const rawResponse = await callLLM(
        'invoice',
        promptWithMappings,
        null,
        imgBytes,
        "application/json"
      );
      console.log("[SUCCESS] Received response from LLM");

      let data;
      try {
        data = JSON.parse(rawResponse);
      } catch (jsonErr) {
        console.error("[ERROR] Failed to parse LLM JSON response:", jsonErr.message);
        return res.status(500).json({ error: "Invalid JSON from LLM", raw: rawResponse });
      }

      let htmlContent = data.full_invoice_html || (Array.isArray(data) ? data[0].full_invoice_html : '');
      if (!htmlContent) {
        return res.status(500).json({ error: "No HTML found in LLM response", raw: rawResponse });
      }

      htmlContent = stripHtmlWrappers(htmlContent);
      console.log(`[INFO] Generated HTML size: ${htmlContent.length} characters`);

      console.log("[INFO] Processing logo, signature, barcode, and qrcode assets...");
      if (logoB64) console.log("[INFO] Using provided logo from frontend");
      if (signatureB64) console.log("[INFO] Using provided signature from frontend");

      const backendCrops = await cropImageParts(imgBytes);

      if (logoB64) backendCrops.logo = logoB64;
      if (signatureB64) backendCrops.signature = signatureB64;

      htmlContent = applyAssetReplacements(htmlContent, backendCrops);
      const htmlResult = htmlContent;

      console.log("[INFO] Generating preview with sample values...");
      let previewHtml = htmlContent;
      try {
        const analysisPrompt = (
          "Look at this document image and extract the current values of all dynamic fields. " +
          "Return ONLY a JSON list of objects with keys 'field_name' and 'value'. " +
          "field_name should be the visible text label (e.g. 'Invoice Number', 'Ship To'). " +
          "Example: [{'field_name': 'Invoice Number', 'value': 'INV-2024-001'}, ...]"
        );
        const analysisRes = await callLLM(
          'invoice',
          analysisPrompt,
          null,
          imgBytes,
          "application/json"
        );
        let fieldData = JSON.parse(analysisRes);
        if (fieldData && typeof fieldData === 'object') {
          if (Array.isArray(fieldData.fields)) fieldData = fieldData.fields;
        }

        if (Array.isArray(fieldData)) {
          for (const item of fieldData) {
            if (!item || typeof item !== 'object') continue;
            const llmLabel = item.field_name || '';
            const sampleValue = item.value || '';
            if (!llmLabel || !sampleValue) continue;

            const sapPath = fieldMappings[llmLabel] || llmLabel;
            const mappedField = sapPath.includes('.') ? sapPath.split('.').pop() : sapPath;
            const placeholder = `{{${mappedField}}}`;
            
            previewHtml = previewHtml.split(placeholder).join(String(sampleValue));
            console.log(`  [Preview] ${placeholder}  →  '${sampleValue}'`);
          }
        }
        console.log("[SUCCESS] Preview substitution complete");
      } catch (mapErr) {
        console.warn("[WARNING] Preview substitution failed:", mapErr.message);
      }

      console.log("="*50);
      console.log("[BACKEND] --- REPLICA GENERATION COMPLETE ---");
      console.log("="*50 + "\n");

      return res.status(200).json({
        status: "success",
        full_html: htmlResult,
        preview_html: previewHtml
      });
    }
  } catch (err) {
    console.error("\n[CRITICAL ERROR] Exception in replicate_invoice:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

