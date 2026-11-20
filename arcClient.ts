/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Data Science Studio's AI through ARC (AI Runtime & Connectivity): one OpenAI-compatible API
// that holds the owner's provider keys and picks a healthy, free model and key for each call.
//
// The studio's AI calls are written for @google/genai (`contents`, `config.systemInstruction`,
// `responseSchema`, `functionDeclarations`) and read `.text` / `.functionCalls`. This module
// translates exactly that to and from OpenAI chat completions, so every call site stays as it is.
// Kept free of side effects (and of the server) so it can be tested on its own.

export interface ArcConfig {
  baseUrl: string;
  apiKey: string;
  /** "auto" (ARC chooses), "arc/fast", or a provider/model ARC lists. */
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ArcFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** The parts of a @google/genai response the studio reads. */
export interface ArcResponse {
  text: string;
  functionCalls: ArcFunctionCall[] | undefined;
  /** Which provider/model ARC used, from its route headers. */
  model: string | null;
  provider: string | null;
}

/** An ARC failure. The message starts with the HTTP status so classifyGeminiError() reads it. */
export class ArcCallError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(`${status} ${code ? `${code}: ` : ''}${message}`);
    this.name = 'ArcCallError';
  }
}

/** ARC is used when both are set (ARC_BASE_URL, ARC_API_KEY). */
export function arcConfigFromEnv(env: Record<string, string | undefined> = process.env): ArcConfig | null {
  const baseUrl = env.ARC_BASE_URL?.trim();
  const apiKey = env.ARC_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, model: env.ARC_MODEL?.trim() || 'auto' };
}

/** Gemini's OpenAPI-style schema (Type.OBJECT = "OBJECT", `nullable`) as JSON Schema. */
export function toJsonSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'propertyOrdering' || k === 'nullable') continue;
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, toJsonSchema(s)]));
    } else if (['items', 'anyOf', 'oneOf', 'allOf', 'not', 'additionalProperties'].includes(k)) out[k] = toJsonSchema(v);
    else out[k] = v;
  }
  if (schema.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(textOf).join('') : (c?.parts ?? []).map((p: any) => p?.text ?? '').join('');

function mediaPart(d: any) {
  const mime = String(d.mimeType ?? d.mime_type ?? 'application/octet-stream').toLowerCase();
  const b64 = String(d.data ?? '');
  if (mime.startsWith('image/')) return { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } };
  return { type: 'file', file: { file_data: `data:${mime};base64,${b64}`, filename: 'attachment' } };
}

/** `contents` may be a string, one Content, a list of strings/parts, or a list of Contents. */
function normaliseContents(contents: any): { role: string; parts: any[] }[] {
  if (typeof contents === 'string') return [{ role: 'user', parts: [{ text: contents }] }];
  if (!Array.isArray(contents)) return contents?.parts ? [{ role: contents.role ?? 'user', parts: contents.parts }] : [];
  if (contents.every((c) => typeof c === 'string' || (c && !('parts' in c) && !('role' in c)))) {
    return [{ role: 'user', parts: contents.map((c) => (typeof c === 'string' ? { text: c } : c)) }];
  }
  return contents.map((c) => (typeof c === 'string' ? { role: 'user', parts: [{ text: c }] } : { role: c.role ?? 'user', parts: c.parts ?? [] }));
}

/** A @google/genai generateContent request as an OpenAI chat completions body (without model). */
export function toOpenAIChat(params: { contents: any; config?: any }): Record<string, any> {
  const config = params.config ?? {};
  const messages: any[] = [];
  const system = textOf(config.systemInstruction);
  if (system) messages.push({ role: 'system', content: system });

  let callCount = 0;
  const pending = new Map<string, string[]>();
  for (const turn of normaliseContents(params.contents)) {
    if (turn.role === 'model') {
      const text = turn.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
      const calls = turn.parts.filter((p) => p.functionCall).map((p) => {
        const name = String(p.functionCall.name ?? '');
        const id = String(p.functionCall.id ?? `call_${++callCount}_${name}`.slice(0, 64));
        pending.set(name, [...(pending.get(name) ?? []), id]);
        return { id, type: 'function', function: { name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
      });
      if (text || calls.length) messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const p of turn.parts.filter((x) => x.functionResponse)) {
      const name = String(p.functionResponse.name ?? '');
      const queue = pending.get(name) ?? [];
      const id = String(p.functionResponse.id ?? queue[0] ?? `call_${++callCount}_${name}`.slice(0, 64));
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(p.functionResponse.response ?? {}) });
    }
    const content: any[] = [];
    for (const p of turn.parts) {
      if (p.functionResponse || p.thought) continue;
      if (typeof p.text === 'string') content.push({ type: 'text', text: p.text });
      else if (p.inlineData || p.inline_data) content.push(mediaPart(p.inlineData ?? p.inline_data));
    }
    if (content.length) {
      messages.push({ role: 'user', content: content.every((c) => c.type === 'text') ? content.map((c) => c.text).join('\n') : content });
    }
  }

  const out: Record<string, any> = { messages };
  const tools = (config.tools ?? []).flatMap((t: any) => t?.functionDeclarations ?? []).map((d: any) => ({
    type: 'function',
    function: {
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      parameters: toJsonSchema(d.parametersJsonSchema ?? d.parameters ?? { type: 'object', properties: {} }),
    },
  }));
  if (tools.length) {
    out.tools = tools;
    const fcc = config.toolConfig?.functionCallingConfig;
    if (fcc) {
      const mode = String(fcc.mode ?? 'AUTO').toUpperCase();
      const allowed: string[] = fcc.allowedFunctionNames ?? [];
      out.tool_choice = mode === 'NONE' ? 'none' : mode === 'ANY' ? (allowed.length === 1 ? { type: 'function', function: { name: allowed[0] } } : 'required') : 'auto';
    }
  }
  if (typeof config.temperature === 'number') out.temperature = config.temperature;
  if (typeof config.topP === 'number') out.top_p = config.topP;
  if (Number.isInteger(config.maxOutputTokens)) out.max_tokens = config.maxOutputTokens;
  if (Array.isArray(config.stopSequences) && config.stopSequences.length) out.stop = config.stopSequences.slice(0, 4);
  if (String(config.responseMimeType ?? '').toLowerCase() === 'application/json') {
    const schema = config.responseJsonSchema ?? config.responseSchema;
    out.response_format = schema
      ? { type: 'json_schema', json_schema: { name: 'response', schema: toJsonSchema(schema) } }
      : { type: 'json_object' };
  }
  return out;
}

/** An OpenAI chat completion as the parts of a @google/genai response the studio reads. */
export function fromOpenAIChat(data: any, route: { model?: string | null; provider?: string | null } = {}): ArcResponse {
  const message = data?.choices?.[0]?.message ?? {};
  const calls: ArcFunctionCall[] = (message.tool_calls ?? []).map((c: any) => {
    let args: Record<string, unknown>;
    try { args = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { args = {}; }
    return { id: c.id, name: String(c.function?.name ?? ''), args };
  });
  let text = typeof message.content === 'string' ? message.content : '';
  // Some providers wrap JSON-mode answers in a Markdown fence; the studio JSON.parse()s .text.
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  if (fenced) text = fenced[1];
  return { text, functionCalls: calls.length ? calls : undefined, model: route.model ?? null, provider: route.provider ?? null };
}

/** One generateContent call through ARC. ARC itself falls back across keys and models. */
export async function arcGenerateContent(cfg: ArcConfig, params: { contents: any; config?: any }): Promise<ArcResponse> {
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
  const timeoutMs = cfg.timeoutMs ?? 25_000;
  const doFetch = cfg.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
        // ARC never keeps trying past this, so the studio's own AI budget holds.
        'x-arc-deadline-ms': String(timeoutMs),
      },
      body: JSON.stringify({ model: cfg.model || 'auto', ...toOpenAIChat(params) }),
      signal: AbortSignal.timeout(timeoutMs + 2_000),
    });
  } catch (err: any) {
    throw new ArcCallError(0, 'network', `ARC is unreachable (${err?.name === 'TimeoutError' ? 'timed out' : 'fetch failed'})`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ArcCallError(res.status, String(data?.error?.code ?? ''), String(data?.error?.message ?? 'ARC request failed'));
  return fromOpenAIChat(data, { model: res.headers.get('x-arc-route-model'), provider: res.headers.get('x-arc-route-provider') });
}

/** Why ARC isn't answering, in words the owner can act on (kinds from classifyGeminiError). */
export function describeArcFailure(kind: string): string {
  switch (kind) {
    case 'bad_key':
      return 'ARC refused this app’s key (revoked, expired or mistyped). Issue a new key for Data Science Studio in ARC and update ARC_API_KEY.';
    case 'quota':
      return 'ARC is rate limiting this app, or every provider key behind it is at its limit for now. It recovers on its own.';
    case 'busy':
      return 'ARC has no healthy free model and key available right now (all resting, unhealthy or disabled). Check ARC’s provider keys; it recovers on its own.';
    case 'network':
      return 'The server could not reach ARC. Check ARC_BASE_URL and that ARC is running.';
    case 'model_unavailable':
      return 'ARC has no model matching ARC_MODEL for this app. Use "auto" or a model ARC lists.';
    default:
      return 'ARC returned an unexpected error.';
  }
}
