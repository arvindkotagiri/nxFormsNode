import { pool } from '../db';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, getModelForProcess } from './llmUtils';

// ─── Observability Tracing ──────────────────────────────────────────────────

export interface LLMTrace {
  trace_id?: string;
  agent_name: string;
  model_used: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  status: 'SUCCESS' | 'FAILED';
  prompt: string;
  response: string;
}

export async function logLLMTrace(trace: LLMTrace) {
  try {
    const query = `
      INSERT INTO llm_traces (
        trace_id, agent_name, model_used,
        prompt_tokens, completion_tokens, total_tokens,
        duration_ms, status, prompt, response
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;
    await pool.query(query, [
      trace.trace_id || `TR-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
      trace.agent_name,
      trace.model_used,
      trace.prompt_tokens,
      trace.completion_tokens,
      trace.total_tokens,
      trace.duration_ms,
      trace.status,
      trace.prompt,
      trace.response
    ]);
    console.log(`[Observability] Logged LLM trace for agent: ${trace.agent_name}`);
  } catch (err) {
    console.error(`[Observability] Error logging LLM trace:`, err);
  }
}

// ─── LangChain Compatibility: Models ───────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'system' | 'assistant';
  content: string;
}

export class ChatModel {
  protected provider: string;
  protected modelId: string;
  protected agentName: string;

  constructor(provider: string, modelId: string, agentName: string) {
    this.provider = provider;
    this.modelId = modelId;
    this.agentName = agentName;
  }

  async invoke(messages: ChatMessage[], options?: { responseMimeType?: string, imageBytes?: Buffer }): Promise<string> {
    const startTime = Date.now();
    const promptText = messages.map(m => `[${m.role}] ${m.content}`).join('\n');
    let responseText = '';
    let pTokens = 0;
    let cTokens = 0;
    let status: 'SUCCESS' | 'FAILED' = 'SUCCESS';

    try {
      if (this.provider === 'google') {
        const apiKey = await getApiKey('gemini');
        let requestedModel = (this.modelId || 'gemini-2.5-flash').replace(/^google:/, '').replace(/^gemini-3\.5-flash$/, 'gemini-2.5-flash').trim();
        const genAI = new GoogleGenerativeAI(apiKey);

        const system = messages.find(m => m.role === 'system')?.content;
        const userMsgs = messages.filter(m => m.role !== 'system');

        const contents = userMsgs.map(m => {
          const parts: any[] = [{ text: m.content }];
          if (m.role === 'user' && options?.imageBytes) {
            parts.unshift({
              inlineData: {
                data: options.imageBytes.toString('base64'),
                mimeType: 'image/png'
              }
            });
          }
          return {
            role: m.role === 'assistant' ? 'model' : 'user',
            parts
          };
        });

        const genConfig: any = { temperature: 0.0 };
        if (options?.responseMimeType) {
          genConfig.responseMimeType = options.responseMimeType;
        }

        const payload: any = { contents, generationConfig: genConfig };
        if (system) {
          payload.systemInstruction = system;
        }

        const candidateModels = Array.from(new Set([
          requestedModel,
          'gemini-2.5-flash',
          'gemini-1.5-flash',
          'gemini-1.5-pro',
          'gemini-2.0-flash'
        ]));

        let res;
        let lastError;
        for (const mName of candidateModels) {
          try {
            console.log(`[ChatModel] Trying model: ${mName}`);
            const model = genAI.getGenerativeModel({ model: mName });
            res = await model.generateContent(payload);
            break;
          } catch (mErr: any) {
            console.warn(`[ChatModel] ${mName} failed (${mErr?.message || mErr}), trying next candidate...`);
            lastError = mErr;
          }
        }

        if (!res) {
          throw lastError || new Error("All Gemini model candidates failed.");
        }

        responseText = res.response.text();
        pTokens = res.response.usageMetadata?.promptTokenCount || 0;
        cTokens = res.response.usageMetadata?.candidatesTokenCount || 0;

      } else if (this.provider === 'openai') {
        const apiKey = await getApiKey('openai');
        const openai = new OpenAI({ apiKey });

        const openAiMessages = messages.map(m => {
          if (m.role === 'user' && options?.imageBytes) {
            return {
              role: m.role,
              content: [
                { type: 'text', text: m.content },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${options.imageBytes.toString('base64')}`
                  }
                }
              ]
            };
          }
          return { role: m.role, content: m.content };
        });

        const res = await openai.chat.completions.create({
          model: this.modelId,
          messages: openAiMessages as any,
          temperature: 0.0,
          response_format: options?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined
        });
        responseText = res.choices[0]?.message?.content || '';
        pTokens = res.usage?.prompt_tokens || 0;
        cTokens = res.usage?.completion_tokens || 0;

      } else if (this.provider === 'anthropic') {
        const apiKey = await getApiKey('anthropic');
        const anthropic = new Anthropic({ apiKey });
        const system = messages.find(m => m.role === 'system')?.content;
        const userMsgs = messages.filter(m => m.role !== 'system');

        const anthropicMessages = userMsgs.map(m => {
          if (m.role === 'user' && options?.imageBytes) {
            return {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: options.imageBytes.toString('base64')
                  }
                },
                { type: 'text', text: m.content }
              ]
            };
          }
          return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
        });

        const res = await anthropic.messages.create({
          model: this.modelId,
          max_tokens: 4096,
          system,
          messages: anthropicMessages as any,
          temperature: 0.0
        });
        responseText = res.content[0]?.type === 'text' ? res.content[0].text : '';
        pTokens = res.usage?.input_tokens || 0;
        cTokens = res.usage?.output_tokens || 0;

      } else {
        throw new Error(`Unsupported provider: ${this.provider}`);
      }

      // If token counts are zero, approximate them using characters count (4 chars/token heuristic)
      if (pTokens === 0) pTokens = Math.ceil(promptText.length / 4);
      if (cTokens === 0) cTokens = Math.ceil(responseText.length / 4);

    } catch (err: any) {
      status = 'FAILED';
      responseText = err.message || String(err);
      throw err;
    } finally {
      const duration = Date.now() - startTime;
      await logLLMTrace({
        agent_name: this.agentName,
        model_used: `${this.provider}:${this.modelId}`,
        prompt_tokens: pTokens,
        completion_tokens: cTokens,
        total_tokens: pTokens + cTokens,
        duration_ms: duration,
        status,
        prompt: promptText.substring(0, 1000),
        response: responseText.substring(0, 2000)
      });
    }

    return responseText;
  }
}

// Helper to construct model based on settings with correct fallbacks
export async function getAgentModel(processName: string, agentName: string): Promise<ChatModel> {
  let modelConfig = await getModelForProcess(processName);
  
  // Use gemini-2.5-flash by default
  if (!modelConfig || modelConfig.trim() === '' || modelConfig === 'google:gemini-3.5-flash') {
    modelConfig = 'google:gemini-2.5-flash';
  }

  let provider = 'google';
  let modelId = modelConfig;

  if (modelConfig.includes(':')) {
    const parts = modelConfig.split(':');
    provider = parts[0];
    modelId = parts.slice(1).join(':');
  }

  return new ChatModel(provider, modelId, agentName);
}

import { repairJsonString } from "./jsonUtils";

// Drop-in Replacement for callLLM using LangChain Compatibility Layer
export async function callLangChainAgent(
  processName: string,
  agentName: string,
  prompt: string,
  systemInstruction: string | null = null,
  imageBytes: Buffer | null = null,
  responseMimeType: string = "application/json"
): Promise<string> {
  const model = await getAgentModel(processName, agentName);
  
  const messages: ChatMessage[] = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: prompt });

  const resText = await model.invoke(messages, {
    responseMimeType,
    imageBytes: imageBytes || undefined
  });

  if (responseMimeType === "application/json") {
    return repairJsonString(resText);
  }

  return resText;
}

// ─── LangGraph Compatibility: State Graph ───────────────────────────────────

export class StateGraph<T extends Record<string, any>> {
  private nodes: Record<string, (state: T) => Promise<Partial<T> | void>> = {};
  private edges: Record<string, string> = {};
  private entryPoint: string = "";

  addNode(name: string, fn: (state: T) => Promise<Partial<T> | void>) {
    this.nodes[name] = fn;
    return this;
  }

  addEdge(from: string, to: string) {
    this.edges[from] = to;
    return this;
  }

  setEntryPoint(name: string) {
    this.entryPoint = name;
    return this;
  }

  compile() {
    return {
      invoke: async (initialState: T): Promise<T> => {
        let state = { ...initialState };
        let currentNode = this.entryPoint;

        while (currentNode && this.nodes[currentNode]) {
          console.log(`[LangGraph] Node Start: ${currentNode}`);
          const updates = await this.nodes[currentNode](state);
          if (updates) {
            state = { ...state, ...updates };
          }
          currentNode = this.edges[currentNode];
        }

        return state;
      }
    };
  }
}
