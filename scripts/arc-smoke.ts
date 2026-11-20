/**
 * Smoke test: Data Science Studio against a running ARC, with the studio's own ARC key.
 *
 *   ARC_BASE_URL=https://arc.example.com/v1 ARC_API_KEY=ARC_DEE_… npx tsx scripts/arc-smoke.ts
 *
 * 1. The request shapes the studio sends (JSON-schema narratives, the ML agent's forced tool
 *    call and its follow-up round) straight through arcClient.ts.
 * 2. The real server (server.ts, production mode, no Gemini key) on a spare port: the AI status
 *    probe must answer through ARC, and the SQL assistant — which has no offline fallback — must
 *    return a real answer.
 * Run it after deploying ARC or rotating the studio's key.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arcConfigFromEnv, arcGenerateContent } from '../arcClient';

const cfg = arcConfigFromEnv();
if (!cfg) {
  console.error('Set ARC_BASE_URL and ARC_API_KEY (Data Science Studio\'s own ARC key).');
  process.exit(2);
}
const arc = { ...cfg, timeoutMs: 30_000 };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
async function check(name: string, fn: () => Promise<string | void>) {
  const started = Date.now();
  try {
    const note = await fn();
    console.log(`ok   ${name} (${Date.now() - started} ms)${note ? ` — ${note}` : ''}`);
  } catch (e: any) {
    failed++;
    console.log(`FAIL ${name}: ${e?.message ?? e}`);
  }
}
function must(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

await check('JSON-schema narrative', async () => {
  const r = await arcGenerateContent(arc, {
    contents: 'Summarize: 1,000 rows, 3% missing in "age", strong skew in "income". Return JSON.',
    config: {
      systemInstruction: 'You are a Data Quality Analyst. Use only the numbers given.',
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { summary: { type: 'STRING' } }, required: ['summary'] },
    },
  });
  const parsed = JSON.parse(r.text);
  must(parsed && typeof parsed === 'object', 'not a JSON object');
  return `${r.model ?? '?'}: ${Object.keys(parsed).join(', ')}`;
});

const tools = [{ functionDeclarations: [
  { name: 'drop_feature', description: 'Retrain without one feature', parameters: { type: 'OBJECT', properties: { feature: { type: 'STRING' }, reasoning: { type: 'STRING' } }, required: ['feature', 'reasoning'] } },
  { name: 'declare_done', description: 'Stop: no further step is likely to help', parameters: { type: 'OBJECT', properties: { reasoning: { type: 'STRING' } }, required: ['reasoning'] } },
] }];
await check('ML agent: forced tool call and the next round', async () => {
  const history: any[] = [{ role: 'user', parts: [{ text: 'Champion r2 0.71 on "price". Features: ["id","sqft","rooms"]. "id" is a row number. Propose the next fix.' }] }];
  const config = { systemInstruction: 'Propose exactly one fix by calling a tool.', tools, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['drop_feature', 'declare_done'] } } };
  const first = await arcGenerateContent(arc, { contents: history, config });
  const call = first.functionCalls?.[0];
  must(call, 'no tool call');
  history.push({ role: 'model', parts: [{ functionCall: { id: call.id, name: call.name, args: call.args } }] });
  history.push({ role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { output: { r2: 0.74 } } } }] });
  const second = await arcGenerateContent(arc, { contents: history, config });
  must(second.functionCalls?.length || second.text, 'no answer after the tool result');
  return `${call.name} → ${second.functionCalls?.[0]?.name ?? 'text'}`;
});

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
});

await check('the studio server answers through ARC', async () => {
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(port), ARC_BASE_URL: cfg.baseUrl, ARC_API_KEY: cfg.apiKey, ARC_MODEL: cfg.model, GEMINI_API_KEY: '', ENGINE_SCHEDULER: '0' };
  const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await fetch(`${base}/api/ai/status`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    must(up, `server did not start:\n${log.slice(-800)}`);
    const status: any = await (await fetch(`${base}/api/ai/status?probe=1`)).json();
    must(status.state === 'ok' && String(status.model).startsWith('ARC'), `AI status: ${JSON.stringify(status).slice(0, 300)}`);
    const sql = await fetch(`${base}/api/sql-assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'orders(id, customer, total, created_at)', question: 'Total revenue per customer' }),
    });
    const body: any = await sql.json();
    must(sql.ok && body && typeof body === 'object', `SQL assistant ${sql.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return `${status.model}; SQL assistant returned ${Object.keys(body).join(', ')}`;
  } finally {
    child.kill('SIGTERM');
  }
});

console.log(failed ? `\n${failed} check(s) failed` : '\nData Science Studio works through ARC.');
process.exit(failed ? 1 : 0);
