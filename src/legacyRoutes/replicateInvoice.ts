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
Task: Generate a PIXEL-PERFECT, PRINT-FLEXIBLE HTML replica of the attached image.

STRICT LAYOUT & PRINTING REQUIREMENTS:
1. DIMENSIONS: Use a fixed container of 816px (width) by 1056px (height) per page. This is exactly 8.5in x 11in (US Letter) at 96DPI.
2. POSITIONING:
   - Header, static text blocks, and metadata sections MUST be positioned using \`position: absolute\` with precise \`px\` values for \`top\`, \`left\`, \`width\`, and \`height\`.
   - The main line-item table MUST be a standard HTML \`<table>\` element. The table rows and cells MUST NOT be absolutely positioned. 
3. TABLE FLOW & PAGINATION RULES:
   - The table MUST support dynamic row additions at runtime.
   - You MUST apply the following print-flexibility CSS classes or styles to the table:
     - \`table { width: 100%; page-break-inside: auto; }\`
     - \`tr { page-break-inside: avoid; page-break-after: auto; }\`
     - \`thead { display: table-header-group; }\` (so headers repeat on new pages if the table spans multiple pages)
     - \`tfoot { display: table-footer-group; }\`
   - If the table overflows onto multiple pages, it should stop 15px above the page footer and break to the next page.
4. FOOTER POSITIONING:
   - The document footer MUST be placed inside a container with class \`footer\` at the bottom of the page.
   - For print styles, use CSS to ensure the footer stays at the bottom:
     \`@media print { .footer { position: fixed; bottom: 0; left: 0; width: 100%; page-break-before: avoid; } }\`
5. ASSETS & PLACEMARKS (CRITICAL FOR MULTI-LLM CONSISTENCY):
   - You MUST represent logo, signatures, barcodes, and QR codes using standard \`<img>\` tags with specific \`data-chunk-type\` attributes:
     - Logo: <img data-chunk-type="logo" src="LOGO_PLACEHOLDER" alt="Logo" style="position: absolute; ...">
     - Signature: <img data-chunk-type="signature" src="SIGNATURE_PLACEHOLDER" alt="Signature" style="position: absolute; ...">
     - Barcode (Code128): <img data-chunk-type="barcode" data-barcode-type="code128" src="BARCODE_PLACEHOLDER" alt="Barcode" style="position: absolute; ...">
     - QR Code: <img data-chunk-type="barcode" data-barcode-type="qr" src="QRCODE_PLACEHOLDER" alt="QR Code" style="position: absolute; ...">
   - Do NOT represent barcodes or QR codes as nested divs, tables, or SVG paths. Use the \`<img>\` placeholder tags exactly as defined above.

TEMPLATE FIELDS:
Replace all dynamic text with {{fieldName}} while keeping the exact position and style of the original text.

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
    const chunkTypeMatch = tag.match(/data-chunk-type=["']([^"']*)["']/i);
    const barcodeTypeMatch = tag.match(/data-barcode-type=["']([^"']*)["']/i);

    const src = srcMatch ? srcMatch[1] : "";
    const alt = altMatch ? altMatch[1] : "";
    const imgId = idMatch ? idMatch[1] : "";
    const style = styleMatch ? styleMatch[1] : "";
    const chunkTypeAttr = chunkTypeMatch ? chunkTypeMatch[1] : "";
    const barcodeTypeAttr = barcodeTypeMatch ? barcodeTypeMatch[1] : "";

    const isWatermark = src.toLowerCase().includes("watermark") || imgId.toLowerCase().includes("watermark") || alt.toLowerCase().includes("watermark");
    if (isWatermark) continue;

    let isLogo = chunkTypeAttr === "logo" || src.toLowerCase().includes("logo") || alt.toLowerCase().includes("logo") || imgId.toLowerCase().includes("logo") || src.toLowerCase().includes("logo_placeholder");
    let isSig = chunkTypeAttr === "signature" || src.toLowerCase().includes("signature") || alt.toLowerCase().includes("signature") || imgId.toLowerCase().includes("signature") || src.toLowerCase().includes("signature_placeholder");
    let isBarcode = (chunkTypeAttr === "barcode" && barcodeTypeAttr !== "qr") || src.toLowerCase().includes("barcode") || alt.toLowerCase().includes("barcode") || imgId.toLowerCase().includes("barcode") || src.toLowerCase().includes("barcode_placeholder") || tag.toLowerCase().includes("barcode");
    let isQrcode = (chunkTypeAttr === "barcode" && barcodeTypeAttr === "qr") || src.toLowerCase().includes("qrcode") || src.toLowerCase().includes("qr_code") || src.toLowerCase().includes("qr") || alt.toLowerCase().includes("qrcode") || imgId.toLowerCase().includes("qrcode") || tag.toLowerCase().includes("qrcode");

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

  const performReplacement = (foundList: any[], cropList: any[], chunkType: string, barcodeType: string | null = null) => {
    foundList.forEach((item, idx) => {
      const tag = item.tag;
      let replacementSrc = "";

      if (chunkType === 'barcode') {
        if (barcodeType === 'qr') {
          replacementSrc = `data:image/svg+xml;utf8,${encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><rect width="150" height="150" fill="white"/><g fill="black"><rect x="15" y="15" width="30" height="30"/><rect x="25" y="25" width="10" height="10" fill="white"/><rect x="105" y="15" width="30" height="30"/><rect x="115" y="25" width="10" height="10" fill="white"/><rect x="15" y="105" width="30" height="30"/><rect x="25" y="115" width="10" height="10" fill="white"/><rect x="65" y="65" width="20" height="20"/><rect x="95" y="95" width="20" height="20"/></g></svg>'
          )}`;
        } else {
          replacementSrc = `data:image/svg+xml;utf8,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><rect width="200" height="80" fill="white"/><g fill="black">${
              Array.from({ length: 25 }).map((_, i) => `<rect x="${10 + i * 7}" y="10" width="${i % 3 === 0 ? 4 : (i % 2 === 0 ? 2 : 1)}" height="50"/>`).join("")
            }</g></svg>`
          )}`;
        }
      } else {
        let cropVal = idx < cropList.length ? cropList[idx][1] : (cropList.length > 0 ? cropList[0][1] : null);
        if (cropVal) {
          if (cropVal.startsWith('data:')) {
            cropVal = cropVal.split(',')[1];
          }
          replacementSrc = `data:image/png;base64,${cropVal}`;
        }
      }

      if (replacementSrc) {
        let newTag = tag.replace(/src=["']([^"']*)["']/i, `src="${replacementSrc}"`);
        if (!newTag.includes('data-editor-element')) {
          newTag = newTag.replace('<img', '<img data-editor-element="true"');
        }
        if (!newTag.includes('data-chunk-type')) {
          newTag = newTag.replace('<img', `<img data-chunk-type="${chunkType}"`);
        }
        if (barcodeType && !newTag.includes('data-barcode-type')) {
          newTag = newTag.replace('<img', `<img data-barcode-type="${barcodeType}"`);
        }
        htmlContent = htmlContent.replace(tag, newTag);
      }
    });
  };

  performReplacement(barcodesFound, barcodeCrops, 'barcode', 'code128');
  performReplacement(qrcodesFound, qrcodeCrops, 'barcode', 'qr');
  performReplacement(signaturesFound, signatureCrops, 'signature');
  performReplacement(logosFound, logoCrops, 'logo');

  for (let [k, v] of Object.entries(crops)) {
    if (v) {
      let b64Src = "";
      const isQr = k.toLowerCase().includes("qrcode") || k.toLowerCase().includes("qr_code");
      const isBarcode = k.toLowerCase().includes("barcode");
      if (isQr) {
        b64Src = `data:image/svg+xml;utf8,${encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150"><rect width="150" height="150" fill="white"/><g fill="black"><rect x="15" y="15" width="30" height="30"/><rect x="25" y="25" width="10" height="10" fill="white"/><rect x="105" y="15" width="30" height="30"/><rect x="115" y="25" width="10" height="10" fill="white"/><rect x="15" y="105" width="30" height="30"/><rect x="25" y="115" width="10" height="10" fill="white"/><rect x="65" y="65" width="20" height="20"/><rect x="95" y="95" width="20" height="20"/></g></svg>'
        )}`;
      } else if (isBarcode) {
        b64Src = `data:image/svg+xml;utf8,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><rect width="200" height="80" fill="white"/><g fill="black">${
            Array.from({ length: 25 }).map((_, i) => `<rect x="${10 + i * 7}" y="10" width="${i % 3 === 0 ? 4 : (i % 2 === 0 ? 2 : 1)}" height="50"/>`).join("")
          }</g></svg>`
        )}`;
      } else {
        let cleanB64 = v;
        if (cleanB64.startsWith('data:')) {
          cleanB64 = cleanB64.split(',')[1];
        }
        b64Src = `data:image/png;base64,${cleanB64}`;
      }

      const matchNum = k.match(/\d+/);
      const searchTerms = [
        `${k.toUpperCase()}_PLACEHOLDER`,
        `${k.toUpperCase()}_PLACEHOLDER_1`,
        `${k.toUpperCase()}_1_PLACEHOLDER`,
        ...(matchNum ? [
          `${k.replace(/\d+/, "").toUpperCase()}PLACEHOLDER_${matchNum[0]}`,
          `${k.replace(/\d+/, "").toUpperCase()}_PLACEHOLDER_${matchNum[0]}`,
          `${k.replace(/\d+/, "").toUpperCase()}_${matchNum[0]}_PLACEHOLDER`
        ] : [])
      ];
      for (const term of searchTerms) {
        htmlContent = htmlContent.split(term).join(b64Src);
      }
    }
  }

  // Post-process HTML to stamp proper editor attributes on all output <img> tags
  const imgTagsPost = htmlContent.match(/<img[^>]*>/gi) || [];
  for (const tag of imgTagsPost) {
    const srcMatch = tag.match(/src=["']([^"']*)["']/i);
    const altMatch = tag.match(/alt=["']([^"']*)["']/i);
    const idMatch = tag.match(/id=["']([^"']*)["']/i);
    const src = srcMatch ? srcMatch[1] : "";
    const alt = altMatch ? altMatch[1] : "";
    const id = idMatch ? idMatch[1] : "";

    let chunkType = "";
    let barcodeType = "";

    if (src.includes("image/svg+xml") || src.includes("qrcode") || src.includes("barcode") || alt.toLowerCase().includes("barcode") || id.toLowerCase().includes("barcode")) {
      chunkType = "barcode";
      barcodeType = (src.includes("width=\"150\"") || src.includes("qrcode") || alt.toLowerCase().includes("qr")) ? "qr" : "code128";
    } else if (src.includes("logo") || alt.toLowerCase().includes("logo") || id.toLowerCase().includes("logo")) {
      chunkType = "logo";
    } else if (src.includes("signature") || alt.toLowerCase().includes("signature") || id.toLowerCase().includes("signature")) {
      chunkType = "signature";
    }

    if (chunkType) {
      let newTag = tag;
      if (!newTag.includes("data-editor-element")) {
        newTag = newTag.replace("<img", '<img data-editor-element="true"');
      }
      if (!newTag.includes("data-chunk-type")) {
        newTag = newTag.replace("<img", `<img data-chunk-type="${chunkType}"`);
      }
      if (chunkType === "barcode" && !newTag.includes("data-barcode-type")) {
        newTag = newTag.replace("<img", `<img data-barcode-type="${barcodeType}"`);
      }
      htmlContent = htmlContent.replace(tag, newTag);
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

