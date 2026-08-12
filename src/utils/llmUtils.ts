// @ts-nocheck
import { pool } from '../db';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

function detectMediaType(imageBytes) {
  if (!imageBytes) return 'image/png';
  
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (imageBytes.length >= 8 && 
      imageBytes[0] === 0x89 && imageBytes[1] === 0x50 && imageBytes[2] === 0x4E && imageBytes[3] === 0x47 &&
      imageBytes[4] === 0x0D && imageBytes[5] === 0x0A && imageBytes[6] === 0x1A && imageBytes[7] === 0x0A) {
    return 'image/png';
  }
  
  // JPEG: FF D8
  if (imageBytes.length >= 2 && imageBytes[0] === 0xFF && imageBytes[1] === 0xD8) {
    return 'image/jpeg';
  }
  
  // GIF: 47 49 46 38 37 61 (GIF87a) or 47 49 46 38 39 61 (GIF89a)
  if (imageBytes.length >= 6 && 
      imageBytes[0] === 0x47 && imageBytes[1] === 0x49 && imageBytes[2] === 0x46 && imageBytes[3] === 0x38 &&
      (imageBytes[4] === 0x37 || imageBytes[4] === 0x39) && imageBytes[5] === 0x61) {
    return 'image/gif';
  }
  
  // WEBP: RIFF...WEBP
  if (imageBytes.length >= 12 && 
      imageBytes[0] === 0x52 && imageBytes[1] === 0x49 && imageBytes[2] === 0x46 && imageBytes[3] === 0x46 && // RIFF
      imageBytes[8] === 0x57 && imageBytes[9] === 0x45 && imageBytes[10] === 0x42 && imageBytes[11] === 0x50) { // WEBP
    return 'image/webp';
  }

  return 'image/png'; // Default fallback
}

export async function getModelForProcess(processName) {
  const key = `model_${processName}`;
  try {
    const res = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    if (res.rows.length > 0 && res.rows[0].value && res.rows[0].value.trim() !== '') {
      return res.rows[0].value;
    }
  } catch (err) {
    console.error(`[DB ERROR] Error fetching model for process ${processName}:`, err);
  }
  return 'google:gemini-3.1-pro-preview'; // Final fallback
}

export async function getApiKey(provider) {
  let lookupProvider = provider;
  if (provider === 'google') {
    lookupProvider = 'gemini';
  }
  const key = `api_${lookupProvider}`;
  try {
    const res = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    if (res.rows.length > 0 && res.rows[0].value) {
      return res.rows[0].value;
    }
  } catch (err) {
    console.error(`[DB ERROR] Error fetching API key for ${provider}:`, err);
  }

  // Fallback to env for gemini/google if not in DB
  if (lookupProvider === 'gemini') {
    return process.env.GEMINI_API_KEY || '';
  }
  return '';
}

export async function callLLM(processName, prompt, systemInstruction = null, imageBytes = null, responseMimeType = "application/json") {
  const modelConfig = await getModelForProcess(processName);
  let provider = 'google';
  let modelId = modelConfig;

  if (modelConfig.includes(':')) {
    const parts = modelConfig.split(':');
    provider = parts[0];
    modelId = parts.slice(1).join(':');
  }

  const providerKeyMap = {
    google: 'gemini',
    openai: 'openai',
    anthropic: 'anthropic'
  };
  
  const apiKey = await getApiKey(providerKeyMap[provider] || provider);
  if (!apiKey) {
    throw new Error(`No API key configured for provider: ${provider}. Please set it in the Settings -> AI Models tab.`);
  }

  const mediaType = imageBytes ? detectMediaType(imageBytes) : 'image/png';

  console.log(`\n>>> [LLM CALL START] Provider: ${provider}, Model: ${modelId}, Process: ${processName} <<<`);
  console.log(`    [INFO] Prompt size: ${prompt.length} chars`);
  if (systemInstruction) console.log(`    [INFO] System instruction size: ${systemInstruction.length} chars`);

  let result;
  if (provider === 'google') {
    result = await callGemini(modelId, apiKey, prompt, systemInstruction, imageBytes, mediaType, responseMimeType);
  } else if (provider === 'openai') {
    result = await callOpenAI(modelId, apiKey, prompt, systemInstruction, imageBytes, mediaType, responseMimeType);
  } else if (provider === 'anthropic') {
    result = await callAnthropic(modelId, apiKey, prompt, systemInstruction, imageBytes, mediaType, responseMimeType);
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  if (responseMimeType === 'application/json') {
    let clean = result.trim();
    
    // 1. Remove markdown code fences if present
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    }
    
    // 2. Try parsing directly, if it fails try repairing first
    try {
      JSON.parse(clean);
    } catch (e) {
      try {
        const repaired = repairJson(clean);
        JSON.parse(repaired);
        clean = repaired;
        console.log("[callLLM] Successfully repaired JSON response directly.");
      } catch (repairErr) {
        console.warn(`[callLLM] JSON.parse/repair failed on clean response, attempting substring extraction... Error: ${e.message}`);
        console.warn(`[callLLM] Clean response length: ${clean.length} characters.`);
        console.warn(`[callLLM] End of clean response: ${clean.substring(Math.max(0, clean.length - 200))}`);
        
        const firstCurly = clean.indexOf('{');
        const firstSquare = clean.indexOf('[');
        let startIndex = -1;
        let endIndex = -1;
        
        if (firstCurly !== -1 && (firstSquare === -1 || firstCurly < firstSquare)) {
          startIndex = firstCurly;
          endIndex = clean.lastIndexOf('}');
        } else if (firstSquare !== -1) {
          startIndex = firstSquare;
          endIndex = clean.lastIndexOf(']');
        }
        
        if (startIndex !== -1) {
          if (endIndex === -1 || endIndex <= startIndex) {
            endIndex = clean.length - 1;
          }
          const potentialJson = clean.substring(startIndex, endIndex + 1);
          try {
            JSON.parse(potentialJson);
            clean = potentialJson;
            console.log("[callLLM] Successfully extracted valid JSON from substring.");
          } catch (innerError) {
            try {
              const repairedPotential = repairJson(potentialJson);
              JSON.parse(repairedPotential);
              clean = repairedPotential;
              console.log("[callLLM] Successfully extracted and repaired JSON from substring.");
            } catch (innerRepairError) {
              console.error("[callLLM] Substring extraction and repair also failed to parse as JSON:", innerRepairError.message);
            }
          }
        }
      }
    }
    return clean;
  }

  return result;
}

function repairJson(jsonStr) {
  let str = jsonStr.trim();
  
  // Remove any trailing commas before brackets/braces
  str = str.replace(/,\s*([\]}])/g, '$1');

  let result = "";
  const stack = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      result += char;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      result += char;
    } else if (char === '}') {
      if (stack[stack.length - 1] === '{') {
        stack.pop();
        result += char;
      } else {
        // Unmatched closing brace - skip it
        console.log(`[repairJson] Skipping unmatched closing brace '}' at position ${i}`);
      }
    } else if (char === ']') {
      if (stack[stack.length - 1] === '[') {
        stack.pop();
        result += char;
      } else {
        // Unmatched closing bracket - skip it
        console.log(`[repairJson] Skipping unmatched closing bracket ']' at position ${i}`);
      }
    } else {
      result += char;
    }
  }

  // If the JSON was truncated inside a string value, close the string quote first
  if (inString) {
    result += '"';
  }

  // Close open brackets/braces in reverse order
  while (stack.length > 0) {
    const openChar = stack.pop();
    if (openChar === '{') {
      result += '}';
    } else if (openChar === '[') {
      result += ']';
    }
  }

  return result;
}

async function callGemini(modelId, apiKey, prompt, systemInstruction, imageBytes, mediaType, responseMimeType) {
  let requestedModel = (modelId || 'gemini-3.5-flash').replace(/^google:/, '').trim();
  const genAI = new GoogleGenerativeAI(apiKey);

  const parts = [];
  if (imageBytes) {
    parts.push({
      inlineData: {
        data: imageBytes.toString('base64'),
        mimeType: mediaType
      }
    });
  }
  parts.push({ text: prompt });

  const contents = [{
    role: 'user',
    parts
  }];

  const generationConfig = {
    temperature: 0.0,
    maxOutputTokens: 8192,
  };
  if (responseMimeType === 'application/json') {
    generationConfig.responseMimeType = 'application/json';
  }

  const options = {
    contents,
    generationConfig
  };
  if (systemInstruction) {
    options.systemInstruction = systemInstruction;
  }

  const candidateModels = Array.from(new Set([
    requestedModel,
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
  ]));

  let lastError;
  for (const mName of candidateModels) {
    try {
      console.log(`   [GEMINI] Sending content to ${mName} (Image: ${!!imageBytes})`);
      const model = genAI.getGenerativeModel({ model: mName });
      const response = await model.generateContent(options);
      const result = response.response.text().trim();
      console.log(`    [GEMINI] Success with ${mName} (${result.length} chars)`);
      return result;
    } catch (err) {
      console.warn(`   [GEMINI] Warning: ${mName} failed (${err?.message || err}), trying next candidate...`);
      lastError = err;
    }
  }

  throw lastError || new Error("All Gemini model candidates failed.");
}

async function callOpenAI(modelId, apiKey, prompt, systemInstruction, imageBytes, mediaType, responseMimeType) {
  const openai = new OpenAI({ apiKey });

  const messages = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }

  const content = [{ type: 'text', text: prompt }];
  if (imageBytes) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mediaType};base64,${imageBytes.toString('base64')}` }
    });
  }
  messages.push({ role: 'user', content });

  console.log(`   [OPENAI] Sending content to ${modelId} (Image: ${!!imageBytes})`);
  const response = await openai.chat.completions.create({
    model: modelId,
    messages,
    response_format: responseMimeType === 'application/json' ? { type: 'json_object' } : undefined,
    temperature: 0.0
  });

  const result = response.choices[0].message.content.trim();
  console.log(`    [OPENAI] Response received (${result.length} chars)`);
  console.log(`    [DEBUG] Response preview: ${result.substring(0, 100)}...`);
  return result;
}

async function callAnthropic(modelId, apiKey, prompt, systemInstruction, imageBytes, mediaType, responseMimeType) {
  const anthropic = new Anthropic({ apiKey });

  const content = [];
  if (imageBytes) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: imageBytes.toString('base64')
      }
    });
  }
  content.push({ type: 'text', text: prompt });

  if (responseMimeType === 'application/json') {
    content.push({ type: 'text', text: 'Respond with valid JSON only. No markdown, no code fences, no explanation.' });
  }

  console.log(`   [ANTHROPIC] Sending content to ${modelId} (Image: ${!!imageBytes})`);
  const response = await anthropic.messages.create({
    model: modelId,
    max_tokens: 8192,
    system: systemInstruction || undefined,
    messages: [{ role: 'user', content }],
    temperature: 0.0
  });

  let raw = response.content[0].text.trim();
  console.log(`    [ANTHROPIC] Response received (${raw.length} chars)`);
  console.log(`    [DEBUG] Response preview: ${raw.substring(0, 100)}...`);

  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  return raw;
}

