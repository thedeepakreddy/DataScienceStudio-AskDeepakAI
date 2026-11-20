import { describe, expect, it } from 'vitest';
import { Type, FunctionCallingConfigMode } from '@google/genai';
import { ArcCallError, arcConfigFromEnv, arcGenerateContent, describeArcFailure, fromOpenAIChat, toJsonSchema, toOpenAIChat } from '../../arcClient';
import { classifyGeminiError } from '../../geminiHealth';

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: `ARC says ${code}` } }), { status, headers: { 'content-type': 'application/json' } });
const completion = (message: object, finish = 'stop') => ({ choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }] });

describe('ARC configuration', () => {
  it('is on only with both ARC_BASE_URL and ARC_API_KEY, model auto by default', () => {
    expect(arcConfigFromEnv({})).toBeNull();
    expect(arcConfigFromEnv({ ARC_BASE_URL: 'https://arc.example/v1' })).toBeNull();
    expect(arcConfigFromEnv({ ARC_BASE_URL: ' https://arc.example/v1 ', ARC_API_KEY: ' k ' })).toEqual({ baseUrl: 'https://arc.example/v1', apiKey: 'k', model: 'auto' });
    expect(arcConfigFromEnv({ ARC_BASE_URL: 'u', ARC_API_KEY: 'k', ARC_MODEL: 'arc/fast' })?.model).toBe('arc/fast');
  });
});

describe('request translation', () => {
  it('turns a JSON-schema narrative call into a system message and response_format', () => {
    const body = toOpenAIChat({
      contents: 'Summarize this EDA.',
      config: {
        systemInstruction: 'You are a Data Quality Analyst.',
        responseMimeType: 'application/json',
        responseSchema: { type: Type.OBJECT, properties: { summary: { type: Type.STRING }, risks: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ['summary'] },
      },
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a Data Quality Analyst.' },
      { role: 'user', content: 'Summarize this EDA.' },
    ]);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: { type: 'object', properties: { summary: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } } }, required: ['summary'] } },
    });
  });

  it('keeps the agent loop consistent: forced tool, calls answered by id, in order', () => {
    const tools = [{ functionDeclarations: [
      { name: 'drop_feature', parameters: { type: Type.OBJECT, properties: { feature: { type: Type.STRING }, reasoning: { type: Type.STRING } }, required: ['feature'] } },
      { name: 'declare_done', parameters: { type: Type.OBJECT, properties: { reasoning: { type: Type.STRING } } } },
    ] }];
    const body = toOpenAIChat({
      contents: [
        { role: 'user', parts: [{ text: 'Real metrics: ...' }] },
        { role: 'model', parts: [{ functionCall: { name: 'drop_feature', args: { feature: 'id' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'drop_feature', response: { output: { r2: 0.81 } } } }] },
      ],
      config: { tools, toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ['drop_feature', 'declare_done'] } } },
    });
    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(body.messages[2].tool_call_id).toBe(body.messages[1].tool_calls[0].id);
    expect(body.messages[2].content).toBe(JSON.stringify({ output: { r2: 0.81 } }));
    expect(body.tool_choice).toBe('required');
    expect(body.tools[0].function.parameters.properties.feature).toEqual({ type: 'string' });
  });

  it('one allowed function becomes a named tool choice; images become data URLs', () => {
    const body = toOpenAIChat({
      contents: [{ role: 'user', parts: [{ text: 'Read this chart' }, { inlineData: { mimeType: 'image/png', data: 'iVBO' } }] }],
      config: { tools: [{ functionDeclarations: [{ name: 'f' }] }], toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } } },
    });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'f' } });
    expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } });
  });

  it('nullable types survive as JSON Schema unions', () => {
    expect(toJsonSchema({ type: 'NUMBER', nullable: true })).toEqual({ type: ['number', 'null'] });
  });
});

describe('response translation', () => {
  it('exposes .text and .functionCalls like @google/genai', () => {
    const r = fromOpenAIChat(completion({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'declare_done', arguments: '{"reasoning":"no gain"}' } }] }, 'tool_calls'));
    expect(r.functionCalls).toEqual([{ id: 'call_1', name: 'declare_done', args: { reasoning: 'no gain' } }]);
    expect(r.text).toBe('');
    expect(fromOpenAIChat(completion({ content: 'plain' })).functionCalls).toBeUndefined();
  });

  it('unwraps JSON that a provider fenced in Markdown, so JSON.parse(.text) works', () => {
    expect(JSON.parse(fromOpenAIChat(completion({ content: '```json\n{"a":1}\n```' })).text)).toEqual({ a: 1 });
  });
});

describe('calling ARC', () => {
  it('sends the app key, a deadline and the model, and reports the route', async () => {
    const seen: any[] = [];
    const r = await arcGenerateContent(
      { baseUrl: 'https://arc.example/v1/', apiKey: 'ARC_DEE_dss_PAK_x', model: 'auto', timeoutMs: 25_000,
        fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return ok(completion({ content: '{"ok":true}' }), { 'x-arc-route-model': 'groq/llama', 'x-arc-route-provider': 'groq' }); }) as any },
      { contents: 'Reply with OK', config: { responseMimeType: 'application/json' } },
    );
    expect(seen[0].url).toBe('https://arc.example/v1/chat/completions');
    expect(seen[0].init.headers.authorization).toBe('Bearer ARC_DEE_dss_PAK_x');
    expect(seen[0].init.headers['x-arc-deadline-ms']).toBe('25000');
    const sent = JSON.parse(seen[0].init.body);
    expect(sent.model).toBe('auto');
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(r).toEqual({ text: '{"ok":true}', functionCalls: undefined, model: 'groq/llama', provider: 'groq' });
  });

  it.each([
    [401, 'invalid_api_key', 'bad_key'],
    [429, 'provider_rate_limited', 'quota'],
    [503, 'no_eligible_route', 'busy'],
  ])('an ARC %i (%s) is classified as %s, with an owner-facing explanation', async (status, code, kind) => {
    const err = await arcGenerateContent({ baseUrl: 'https://arc.example', apiKey: 'k', fetchImpl: (async () => fail(status, code)) as any }, { contents: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ArcCallError);
    expect(classifyGeminiError(err)).toBe(kind);
    expect(describeArcFailure(kind)).toMatch(/ARC/);
  });

  it('an unreachable ARC is a network failure', async () => {
    const err = await arcGenerateContent({ baseUrl: 'https://arc.example', apiKey: 'k', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as any }, { contents: 'x' }).catch((e) => e);
    expect(classifyGeminiError(err)).toBe('network');
  });
});
