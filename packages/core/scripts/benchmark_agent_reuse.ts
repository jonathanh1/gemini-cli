
import { Config } from '../src/config/config.js';
import { GeminiChat, StreamEventType } from '../src/core/geminiChat.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuthType } from '../src/core/contentGenerator.js';

async function runBenchmark() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error('Error: GOOGLE_API_KEY environment variable is required.');
    process.exit(1);
  }

  console.log('Starting AgentReuse Benchmark (Real API Mode - Retrieval Augmented)...');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-benchmark-'));
  const files = ['utils.ts', 'helper.ts', 'api.ts', 'core.ts', 'main.ts'];
  for (const file of files) {
    await fs.writeFile(path.join(tempDir, file), `// content of ${file}`);
  }

  const results: any[] = [];

  const baseConfigParams = {
    sessionId: 'benchmark-session',
    targetDir: tempDir,
    debugMode: false,
    model: 'gemini-3-flash-preview',
    enablePlanReuse: false,
  };

  const runTurn = async (chat: GeminiChat, message: string): Promise<{latency: number, tokens: number}> => {
    const start = performance.now();
    let tokens = 0;
    try {
        let stream = await chat.sendMessageStream({ model: 'gemini-3-flash-preview' }, message, 'benchmark-prompt', new AbortController().signal);

        let toolCall = null;
        for await (const event of stream) {
            if (event.type === StreamEventType.CHUNK) {
                if (event.value.usageMetadata?.candidatesTokenCount) {
                    tokens += event.value.usageMetadata.candidatesTokenCount;
                }
                if (event.value.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
                    toolCall = event.value.candidates[0].content.parts[0].functionCall;
                }
            }
        }

        if (toolCall) {
            const functionResponse = {
                functionResponse: {
                    id: 'call_id',
                    name: toolCall.name,
                    response: { output: 'success' }
                }
            };
            stream = await chat.sendMessageStream({ model: 'gemini-3-flash-preview' }, [functionResponse], 'benchmark-prompt', new AbortController().signal);
            for await (const event of stream) {
                 if (event.type === StreamEventType.CHUNK && event.value.usageMetadata?.candidatesTokenCount) {
                    tokens += event.value.usageMetadata.candidatesTokenCount;
                }
            }
        }
    } catch (e) {
        console.error(`Error processing "${message}":`, e);
    }
    const end = performance.now();
    return { latency: end - start, tokens };
  };

  // 1. Baseline
  console.log('\n--- Running Baseline (Reuse OFF) ---');
  for (const file of files) {
    const config = new Config({ ...baseConfigParams, enablePlanReuse: false } as any);
    await config.refreshAuth(AuthType.USE_GEMINI);
    await config.initialize();

    const chat = new GeminiChat(config);
    const res = await runTurn(chat, `Read the file ${file}`);
    console.log(`Latency: ${res.latency.toFixed(2)}ms, Tokens: ${res.tokens}`);
    results.push({ mode: 'baseline', ...res });
  }

  // 2. Warmup
  console.log('\n--- Running Warmup (Reuse ON - Cache Miss) ---');
  const cachePath = path.join(process.cwd(), '.gemini', 'cache', 'plans.json');
  try { await fs.unlink(cachePath); } catch (e) {}

  const reuseConfig = new Config({ ...baseConfigParams, enablePlanReuse: true } as any);
  await reuseConfig.refreshAuth(AuthType.USE_GEMINI);
  await reuseConfig.initialize();

  const reuseChat = new GeminiChat(reuseConfig);
  const trainRes = await runTurn(reuseChat, `Read the file ${files[0]}`);
  console.log(`Warmup Latency: ${trainRes.latency.toFixed(2)}ms, Tokens: ${trainRes.tokens}`);

  // 3. Experiment
  console.log('\n--- Running Experiment (Reuse ON - Cache Hit) ---');
  for (let i = 1; i < files.length; i++) {
    const file = files[i];
    const chat = new GeminiChat(reuseConfig);
    const res = await runTurn(chat, `Read the file ${file}`);
    console.log(`Latency: ${res.latency.toFixed(2)}ms, Tokens: ${res.tokens}`);
    results.push({ mode: 'reuse', ...res });
  }

  // Analysis
  const baseline = results.filter(r => r.mode === 'baseline');
  const reuse = results.filter(r => r.mode === 'reuse');

  const avgBaselineLatency = baseline.reduce((a, b) => a + b.latency, 0) / baseline.length;
  const avgReuseLatency = reuse.reduce((a, b) => a + b.latency, 0) / reuse.length;

  const avgBaselineTokens = baseline.reduce((a, b) => a + b.tokens, 0) / baseline.length;
  const avgReuseTokens = reuse.reduce((a, b) => a + b.tokens, 0) / reuse.length;

  console.log(`\nAverage Baseline: ${avgBaselineLatency.toFixed(2)}ms, ${avgBaselineTokens.toFixed(1)} tokens`);
  console.log(`Average Reuse:    ${avgReuseLatency.toFixed(2)}ms, ${avgReuseTokens.toFixed(1)} tokens`);

  const latImprovement = ((avgBaselineLatency - avgReuseLatency) / avgBaselineLatency * 100);
  const tokImprovement = ((avgBaselineTokens - avgReuseTokens) / avgBaselineTokens * 100);

  console.log(`Latency Improvement: ${latImprovement.toFixed(2)}%`);
  console.log(`Token Improvement:   ${tokImprovement.toFixed(2)}%`);

  await fs.rm(tempDir, { recursive: true, force: true });
}

runBenchmark().catch(console.error);
