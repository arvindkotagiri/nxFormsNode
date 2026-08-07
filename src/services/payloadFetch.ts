import axios, { AxiosError } from "axios";

export type ContextConfig = {
  name: string;
  endpoint: string;
  get_url?: string | null;
  auth_type?: string | null;
  auth_url?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  username?: string | null;
  password?: string | null;
  entities?: unknown;
  fields?: unknown;
};

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type HttpResponse = {
  status: number;
  data: unknown;
};

type HttpClient = {
  get: (url: string, config?: Record<string, unknown>) => Promise<HttpResponse>;
  post: (url: string, body?: unknown, config?: Record<string, unknown>) => Promise<HttpResponse>;
};

type FetchOptions = {
  timeoutMs?: number;
  httpClient?: HttpClient;
  logger?: Logger;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.ODATA_REQUEST_TIMEOUT_MS ?? 30000);

const defaultLogger: Logger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

function normalizeAuthType(authType?: string | null): "oauth2" | "basic" | "none" {
  const raw = String(authType ?? "none").trim().toLowerCase();
  if (raw.includes("oauth")) return "oauth2";
  if (raw.includes("basic")) return "basic";
  return "none";
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function hasEntityPlaceholder(url: string): boolean {
  return /\{\{[^{}]+\}\}|\{[^{}]+\}|:[A-Za-z_][A-Za-z0-9_-]*\b|\$[A-Za-z_][A-Za-z0-9_]*\$/.test(url);
}

function replaceEntityPlaceholder(url: string, entityKey: string): string {
  const encoded = encodeURIComponent(entityKey);
  return url
    .replace(/\{\{[^{}]+\}\}/g, encoded)
    .replace(/\{[^{}]+\}/g, encoded)
    .replace(/:[A-Za-z_][A-Za-z0-9_-]*\b/g, encoded)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*\$/g, encoded);
}

function replaceFilterOperand(endpoint: string, entityKey: string): string | null {
  if (!/\$filter=/i.test(endpoint) || !/\beq\b/i.test(endpoint)) return null;
  const quoted = `'${escapeODataString(entityKey)}'`;
  const replaced = endpoint.replace(/(\$filter=[^&]*?\beq\s*)(?:'[^']*'|[^&]+)/i, `$1${quoted}`);
  return replaced;
}

function singularizeEntitySet(entitySet: string): string {
  if (entitySet.endsWith("ies")) return `${entitySet.slice(0, -3)}y`;
  if (entitySet.endsWith("ses")) return entitySet.slice(0, -2);
  if (entitySet.endsWith("s") && entitySet.length > 1) return entitySet.slice(0, -1);
  return entitySet;
}

function inferEntitySetCandidates(ctx: ContextConfig): string[] {
  const candidates = new Set<string>();

  const entities = Array.isArray(ctx.entities) ? (ctx.entities as Array<Record<string, unknown>>) : [];
  for (const entity of entities) {
    const name = String(entity?.name ?? "").trim();
    if (!name) continue;
    candidates.add(name);
    if (!name.endsWith("s")) candidates.add(`${name}s`);
    if (/Header$/i.test(name)) {
      const stem = name.replace(/Header$/i, "");
      if (stem) {
        candidates.add(stem);
        candidates.add(`${stem}s`);
      }
    }
    if (/Type$/i.test(name)) {
      const stem = name.replace(/Type$/i, "");
      if (stem) {
        candidates.add(stem);
        candidates.add(`${stem}s`);
      }
    }
  }

  return Array.from(candidates).filter(Boolean);
}

function inferKeyFieldCandidates(ctx: ContextConfig, entitySet: string): string[] {
  const candidates = new Set<string>();

  const fromFieldDefinitions: string[] = [];
  if (ctx.fields && typeof ctx.fields === "object") {
    const obj = ctx.fields as Record<string, unknown>;
    for (const value of Object.values(obj)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const f = item as Record<string, unknown>;
        const name = String(f.name ?? f.originalName ?? "").trim();
        if (name) fromFieldDefinitions.push(name);
      }
    }
  }

  const preferred = fromFieldDefinitions.filter((field) => /id$/i.test(field));
  for (const field of preferred) candidates.add(field);

  const singular = singularizeEntitySet(entitySet);
  if (singular) {
    candidates.add(singular);
    candidates.add(`${singular}Id`);
    candidates.add(`${singular}ID`);
    candidates.add(`${singular}_id`);
  }

  candidates.add("ID");
  candidates.add("Id");
  candidates.add("id");

  for (const field of fromFieldDefinitions) {
    candidates.add(field);
  }

  return Array.from(candidates);
}

function toLegacyCollections(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { results: value.map((item) => toLegacyCollections(item)) };
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) {
      out[k] = toLegacyCollections(v);
    }
    return out;
  }
  return value;
}

function extractRows(data: unknown): Record<string, unknown>[] {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data.filter((row) => row && typeof row === "object") as Record<string, unknown>[];
  }

  if (typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.value)) {
    return obj.value.filter((row) => row && typeof row === "object") as Record<string, unknown>[];
  }

  const d = obj.d as Record<string, unknown> | undefined;
  if (d && Array.isArray((d as Record<string, unknown>).results)) {
    return ((d as Record<string, unknown>).results as unknown[]).filter((row) => row && typeof row === "object") as Record<string, unknown>[];
  }

  if (d && typeof d === "object") {
    return [d];
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      return value.filter((row) => row && typeof row === "object") as Record<string, unknown>[];
    }
  }

  return [obj];
}

function summarizeBodyShape(data: unknown): string {
  if (data === null) return "null";
  if (Array.isArray(data)) return `array(len=${data.length})`;
  if (typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    return `object(keys=${keys.slice(0, 10).join(",")}${keys.length > 10 ? ",..." : ""})`;
  }
  return typeof data;
}

function sanitizeHeadersForLog(headers: Record<string, string>): Record<string, string> {
  const safe = { ...headers };
  if (safe.Authorization) {
    const auth = safe.Authorization;
    if (/^Bearer\s+/i.test(auth)) safe.Authorization = "Bearer ***";
    else if (/^Basic\s+/i.test(auth)) safe.Authorization = "Basic ***";
    else safe.Authorization = "***";
  }
  return safe;
}

function normalizeLivePayload(raw: unknown): Record<string, unknown> {
  const rows = extractRows(raw);
  if (rows.length === 0) {
    throw new Error("OData response contained no records for the requested entity_key");
  }

  const first = toLegacyCollections(rows[0]) as Record<string, unknown>;
  const result: Record<string, unknown> = {
    ...first,
    d: first,
  };

  return result;
}

function getServiceRoot(endpoint: string): string {
  const parsed = new URL(endpoint);
  const pathname = parsed.pathname.replace(/\/\$metadata\/?$/i, "").replace(/\/$/, "");
  return `${parsed.origin}${pathname}`;
}

function getBaseQuery(endpoint: string): URLSearchParams {
  const parsed = new URL(endpoint);
  const params = new URLSearchParams(parsed.search);
  params.delete("$format");
  return params;
}

function buildCandidateUrls(ctx: ContextConfig, entityKey: string): string[] {
  const endpoint = String(ctx.get_url || ctx.endpoint || "").trim();
  if (!endpoint) return [];

  if (hasEntityPlaceholder(endpoint)) {
    return [replaceEntityPlaceholder(endpoint, entityKey)];
  }

  const replacedFilter = replaceFilterOperand(endpoint, entityKey);
  if (replacedFilter) {
    return [replacedFilter];
  }

  const parsed = new URL(endpoint);
  const endpointPath = parsed.pathname.replace(/\/$/, "");
  const serviceRoot = getServiceRoot(endpoint);
  const baseQuery = getBaseQuery(endpoint);
  const hasFilter = baseQuery.has("$filter");

  const entityCandidates = inferEntitySetCandidates(ctx);

  const endpointLastSegment = endpointPath.split("/").filter(Boolean).pop() || "";
  const looksLikeEntitySet = /[A-Z]/.test(endpointLastSegment) || endpointLastSegment.endsWith("s");
  if (looksLikeEntitySet && endpointLastSegment.toLowerCase() !== "$metadata") {
    entityCandidates.unshift(endpointLastSegment);
  }

  const uniqueEntityCandidates = Array.from(new Set(entityCandidates.filter(Boolean)));
  const candidateUrls: string[] = [];

  for (const entitySet of uniqueEntityCandidates) {
    const keyFields = inferKeyFieldCandidates(ctx, entitySet);
    const escapedKey = escapeODataString(entityKey);

    const predicateQuery = new URLSearchParams(baseQuery);
    predicateQuery.set("$format", "json");

    const byPredicate = `${serviceRoot}/${entitySet}('${encodeURIComponent(entityKey)}')${predicateQuery.toString() ? `?${predicateQuery.toString()}` : ""}`;
    candidateUrls.push(byPredicate);

    for (const keyField of keyFields) {
      const query = new URLSearchParams(baseQuery);
      if (!hasFilter) {
        query.set("$filter", `${keyField} eq '${escapedKey}'`);
      }
      query.set("$top", "1");
      query.set("$format", "json");
      candidateUrls.push(`${serviceRoot}/${entitySet}?${query.toString()}`);
    }
  }

  return Array.from(new Set(candidateUrls));
}

function buildAxiosErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== "object") return fallback;
  const axErr = err as AxiosError;
  const status = axErr.response?.status;
  const statusText = axErr.response?.statusText;
  const responseData = axErr.response?.data;
  const upstream = typeof responseData === "string"
    ? responseData
    : (responseData as Record<string, unknown> | undefined)?.error_description
      ?? (responseData as Record<string, unknown> | undefined)?.message
      ?? (responseData as Record<string, unknown> | undefined)?.error;

  return [
    fallback,
    status ? `status=${status}` : null,
    statusText ? `statusText=${statusText}` : null,
    upstream ? `upstream=${String(upstream)}` : null,
  ].filter(Boolean).join(" | ");
}

async function buildAuthHeaders(
  ctx: ContextConfig,
  httpClient: HttpClient,
  timeoutMs: number,
  logger: Logger,
): Promise<Record<string, string>> {
  const authMode = normalizeAuthType(ctx.auth_type);
  const headers: Record<string, string> = { Accept: "application/json" };

  if (authMode === "oauth2") {
    if (!ctx.auth_url || !ctx.client_id || !ctx.client_secret) {
      throw new Error("Context is configured for OAuth2 but auth_url/client_id/client_secret is missing");
    }

    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    params.set("client_id", String(ctx.client_id));
    params.set("client_secret", String(ctx.client_secret));

    const basic = Buffer.from(`${ctx.client_id}:${ctx.client_secret}`).toString("base64");
    logger.info(`[API2] OAuth token request started for context=${ctx.name}`);

    try {
      const tokenResp = await httpClient.post(String(ctx.auth_url), params.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        timeout: timeoutMs,
      });

      const token = (tokenResp.data as Record<string, unknown> | undefined)?.access_token as string | undefined;
      if (!token) {
        throw new Error("OAuth token response did not include access_token");
      }

      headers.Authorization = `Bearer ${token}`;
      logger.info(`[API2] OAuth token request succeeded for context=${ctx.name}; tokenLength=${token.length}`);
      return headers;
    } catch (err) {
      throw new Error(buildAxiosErrorMessage(err, `OAuth token request failed for context=${ctx.name}`));
    }
  }

  if (authMode === "basic") {
    if (!ctx.username || !ctx.password) {
      throw new Error("Context is configured for Basic auth but username/password is missing");
    }
    const basic = Buffer.from(`${ctx.username}:${ctx.password}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
    return headers;
  }

  return headers;
}

export async function fetchContextPayload(
  ctx: ContextConfig,
  entityKey: string,
  options?: FetchOptions,
): Promise<Record<string, unknown>> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const httpClient = options?.httpClient ?? axios;
  const logger = options?.logger ?? defaultLogger;

  if (!ctx.endpoint || !String(ctx.endpoint).trim()) {
    throw new Error(`Context ${ctx.name} has no endpoint configured`);
  }

  const headers = await buildAuthHeaders(ctx, httpClient, timeoutMs, logger);
  const candidateUrls = buildCandidateUrls(ctx, entityKey);

  if (candidateUrls.length === 0) {
    throw new Error(`No candidate URL could be built for context=${ctx.name}`);
  }

  let lastError: Error | null = null;

  for (const requestUrl of candidateUrls) {
    try {
      logger.info(`[API2] OData request URL: ${requestUrl}`);
      logger.info(`[API2] OData request headers:`, sanitizeHeadersForLog(headers));

      const response = await httpClient.get(requestUrl, {
        headers,
        timeout: timeoutMs,
      });

      logger.info(`[API2] OData response status: ${response.status} for ${requestUrl}`);
      logger.info(`[API2] OData response body shape: ${summarizeBodyShape(response.data)}`);

      const normalized = normalizeLivePayload(response.data);
      logger.info(`[API2] OData parsing succeeded for context=${ctx.name}; record extracted`);
      return normalized;
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      if (/contained no records/i.test(rawMessage)) {
        throw err;
      }
      const message = buildAxiosErrorMessage(err, `OData request failed for ${requestUrl}`);
      logger.warn(`[API2] ${message}`);
      lastError = new Error(message);
    }
  }

  throw lastError ?? new Error(`All OData request attempts failed for context=${ctx.name}`);
}

export const __testables = {
  buildCandidateUrls,
  extractRows,
  normalizeLivePayload,
  replaceFilterOperand,
  hasEntityPlaceholder,
  replaceEntityPlaceholder,
  sanitizeHeadersForLog,
};
