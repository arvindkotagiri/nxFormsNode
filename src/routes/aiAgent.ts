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

    const systemInstruction = `You are an expert SAP Document Template & Data Mapping AI Copilot for nxForms.
Your mission is to guide users on mapping SAP payload fields to HTML document elements, configuring table loop entity sets, and providing direct clickable actions to apply those mappings.

INPUT DATA PROVIDED TO YOU:
1. Payload Schema: Available SAP entities (e.g., head, item) and field paths (e.g., head.SalesOrder, item.material).
2. Canvas HTML: The current HTML layout structure of the template.
3. Selected Element (optional): The element currently highlighted by the user.
4. Reference Image (optional): Visual reference of the desired final print output.

RULES FOR YOUR RESPONSE:
You MUST respond strictly in valid JSON format matching this TypeScript interface:
{
  "reply": "Clear, friendly explanation of the suggested mappings and table loop recommendations.",
  "suggestedActions": [
    {
      "id": "action-1",
      "actionType": "MAP_FIELD", // or "CONFIGURE_TABLE_LOOP"
      "targetSelector": "element identifier, ID, or description (e.g. td:nth-child(2), #sales-order-val, table)",
      "targetTextSnippet": "Original text snippet in HTML to match if ID is missing",
      "fieldPath": "head.SalesOrder",
      "displayLabel": "Sales Order #",
      "tableConfig": {
        "entitySetKey": "item",
        "innerEntitySetKey": "",
        "sortCriteria": [],
        "alreadySorted": false,
        "filters": [],
        "subtotalFields": ["netprice", "total"]
      },
      "explanation": "Why this mapping or table loop configuration is recommended."
    }
  ]
}

DO NOT include raw markdown code blocks like \`\`\`json. Output ONLY the JSON object.`;

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
