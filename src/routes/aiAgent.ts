import { Router, Request, Response } from 'express';
import { getApiKey, getModelForProcess } from '../utils/llmUtils';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { logLLMTrace } from '../utils/langchainCompat';

const router = Router();

interface MappingAgentRequest {
  prompt?: string;
  payloadSchema?: any;
  htmlContent?: string;
  selectedElementInfo?: any;
  imageData?: string; // base64
  chatHistory?: { role: 'user' | 'assistant'; content: string }[];
}

router.post('/mapping-agent', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const {
      prompt = "Analyze the template HTML and payload schema to suggest field mappings and table loop configuration.",
      payloadSchema,
      htmlContent,
      selectedElementInfo,
      imageData,
      chatHistory = []
    }: MappingAgentRequest = req.body;

    // Resolve model from DB settings (same pattern as other agents)
    const modelConfig = await getModelForProcess('mapping');
    let provider = 'google';
    let modelName = modelConfig;
    if (modelConfig && modelConfig.includes(':')) {
      const parts = modelConfig.split(':');
      provider = parts[0];
      modelName = parts.slice(1).join(':');
    }
    if (!modelName) modelName = 'gemini-2.5-flash-preview-05-20';

    // Resolve API key for the provider
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || (await getApiKey(provider === 'google' ? 'gemini' : provider));
    console.log(`[AI Agent] Using model: ${modelName} (provider: ${provider}), key length: ${apiKey ? apiKey.length : 0}`);
    if (!apiKey) {
      return res.status(400).json({
        error: "GEMINI_API_KEY is not configured in .env or database settings."
      });
    }

    let llm = new ChatGoogleGenerativeAI({
      apiKey,
      model: modelName,
      temperature: 0.2,
      maxOutputTokens: 2048,
    });

    const systemInstruction = `You are an expert SAP Document Template & Data Mapping AI Copilot for nxForms — a conversational assistant that helps users map SAP payload fields to HTML template variables and configure table loops.

You operate in a CHAT-BASED interface. You MUST understand natural language requests and respond conversationally while also producing actionable suggestions.

=== UNDERSTANDING USER INTENT ===
The user may say things like:
- "I want to loop the table according to how many items a contact person has" → Identify the entity in the payload schema that represents "contact persons" or "items" and generate a CONFIGURE_TABLE_LOOP suggestion using that entitySetKey, plus MAP_FIELD suggestions for all columns in that entity.
- "Map the order number field" → Find the payload field matching "order number" (e.g. head.SalesOrder) and suggest MAP_FIELD for any element in the HTML that looks like an order number placeholder.
- "What fields can I map for the header?" → List the head.* fields from the payload schema and suggest MAP_FIELD actions for each.
- "Auto map everything" → Suggest MAP_FIELD actions for ALL payload fields (head + item) plus CONFIGURE_TABLE_LOOP for any table entity.
- "How do I loop this by [entity]?" → Respond conversationally explaining how the loop works, and provide CONFIGURE_TABLE_LOOP suggestion with the correct entitySetKey from the payload schema.

=== RULES FOR targetTextSnippet (CRITICAL) ===
The targetTextSnippet field is used to FIND the element in the HTML canvas to replace. It must be:
- The EXACT text content of an element in the HTML template (e.g. "{{VBELN}}", "Order Number", "{{material}}")
- If the HTML contains {{VARIABLE}} placeholders, use that exact {{VARIABLE}} as the targetTextSnippet
- This tells the system WHICH element to replace when the user clicks Apply

=== PAYLOAD SCHEMA UNDERSTANDING ===
- head.* = header-level fields (one per document): order number, customer, date, etc.
- item.* = line-item level fields (repeating rows): material, quantity, price, etc.
- Any array-type entity = candidate for CONFIGURE_TABLE_LOOP

=== OUTPUT FORMAT ===
Respond STRICTLY in valid JSON (NO markdown code blocks):
{
  "reply": "Conversational, helpful explanation of what you found and what you're suggesting. Be specific — mention field names, entity keys, and explain WHY each mapping makes sense.",
  "suggestedActions": [
    {
      "id": "action-1",
      "actionType": "MAP_FIELD",
      "targetSelector": "CSS selector (e.g. td:nth-child(2), #order-num) — optional if targetTextSnippet is provided",
      "targetTextSnippet": "EXACT text of the HTML element to replace (e.g. {{VBELN}}, Order Number, {{mat}})",
      "fieldPath": "head.SalesOrder",
      "displayLabel": "Sales Order #",
      "explanation": "Why this field maps to this element"
    },
    {
      "id": "action-2",
      "actionType": "CONFIGURE_TABLE_LOOP",
      "targetSelector": "table",
      "targetTextSnippet": "",
      "fieldPath": "",
      "displayLabel": "Loop table by item",
      "tableConfig": {
        "entitySetKey": "item",
        "innerEntitySetKey": "",
        "sortCriteria": [],
        "alreadySorted": false,
        "filters": [],
        "subtotalFields": []
      },
      "explanation": "Loop this table for each item in the payload. This will repeat the table rows once per item."
    }
  ]
}

DO NOT output raw markdown or code fences. Output ONLY the JSON object.`;

    const contextStr = `
=== PAYLOAD SCHEMA ===
${JSON.stringify(payloadSchema || {}, null, 2)}

=== HTML TEMPLATE STRUCTURE ===
${(htmlContent || "").substring(0, 3000)}

=== SELECTED ELEMENT ===
${JSON.stringify(selectedElementInfo || {}, null, 2)}

=== USER PROMPT ===
${prompt}
`;

    const messages: any[] = [
      new SystemMessage(systemInstruction)
    ];

    // Append chat history
    for (const msg of chatHistory.slice(-6)) {
      if (msg.role === 'user') {
        messages.push(new HumanMessage(msg.content));
      } else {
        messages.push(new AIMessage(msg.content));
      }
    }

    // Build current turn message
    if (imageData && imageData.startsWith('data:image')) {
      const base64Data = imageData.split(',')[1] || imageData;
      const mimeType = imageData.split(';')[0].split(':')[1] || 'image/png';
      
      messages.push(
        new HumanMessage({
          content: [
            { type: "text", text: contextStr },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Data}`
              }
            }
          ]
        })
      );
    } else {
      messages.push(new HumanMessage(contextStr));
    }

    console.log(`[AI Agent] Calling LangChain Gemini Flash model (${modelName}) for prompt: "${prompt.substring(0, 50)}..."`);
    let result;
    try {
      result = await llm.invoke(messages);
    } catch (modelErr: any) {
      console.warn(`[AI Agent] Model ${modelName} invocation failed, falling back to gemini-2.5-flash-preview-05-20:`, modelErr?.message);
      const fallbackLlm = new ChatGoogleGenerativeAI({
        apiKey,
        model: "gemini-2.5-flash-preview-05-20",
        temperature: 0.2,
        maxOutputTokens: 2048,
      });
      result = await fallbackLlm.invoke(messages);
    }
    const rawContent = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

    // Clean JSON fences if any
    let cleaned = rawContent.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    let parsedResponse: any;
    try {
      parsedResponse = JSON.parse(cleaned);
    } catch (e) {
      console.warn("[AI Agent] JSON parse failed, returning raw text reply", e);
      parsedResponse = {
        reply: rawContent,
        suggestedActions: []
      };
    }

    // Log observability trace
    const duration = Date.now() - startTime;
    logLLMTrace({
      agent_name: 'AI_Mapping_Copilot',
      model_used: modelName,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      duration_ms: duration,
      status: 'SUCCESS',
      prompt: prompt,
      response: cleaned
    }).catch(() => {});

    return res.json({
      success: true,
      data: parsedResponse
    });

  } catch (error: any) {
    console.error("[AI Agent] Error generating mapping suggestions:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Failed to generate AI mapping suggestions."
    });
  }
});

export default router;
