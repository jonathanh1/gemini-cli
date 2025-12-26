
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

  console.log('Starting AgentReuse Benchmark (Real API Mode)...');

  // Setup temp workspace
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-benchmark-'));
  console.log(`Workspace: ${tempDir}`);

  // Create dummy files
  const files = ['utils.ts', 'helper.ts', 'api.ts', 'core.ts', 'main.ts'];
  for (const file of files) {
    await fs.writeFile(path.join(tempDir, file), `// content of ${file}`);
  }

  const results: any[] = [];

  const baseConfigParams = {
    sessionId: 'benchmark-session',
    targetDir: tempDir,
    debugMode: false,
    model: 'gemini-3-flash-preview', // Use Flash as requested/fallback
    enablePlanReuse: false,
  };

  const runTurn = async (chat: GeminiChat, message: string): Promise<number> => {
    const start = performance.now();
    try {
        // 1. Send User Prompt
        let stream = await chat.sendMessageStream({ model: 'gemini-3-flash-preview' }, message, 'benchmark-prompt', new AbortController().signal);

        let toolCall = null;
        for await (const event of stream) {
            if (event.type === StreamEventType.CHUNK && event.value.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
                toolCall = event.value.candidates[0].content.parts[0].functionCall;
            }
        }

        // 2. If Tool Call, Send Response to Trigger Reuse Learning
        // We only simulate the round trip, we don't actually need to execute the tool logic for latency measurment,
        // but we MUST send a response so the system learns.
        if (toolCall) {
            const functionResponse = {
                functionResponse: {
                    id: 'call_id', // Dummy ID
                    name: toolCall.name,
                    response: { output: 'success' }
                }
            };
            stream = await chat.sendMessageStream({ model: 'gemini-3-flash-preview' }, [functionResponse], 'benchmark-prompt', new AbortController().signal);
            for await (const event of stream) {}
        }
    } catch (e) {
        console.error(`Error processing "${message}":`, e);
    }
    const end = performance.now();
    return end - start;
  };

  // 1. Baseline
  console.log('\n--- Running Baseline (Reuse OFF) ---');
  for (const file of files) {
    const config = new Config({ ...baseConfigParams, enablePlanReuse: false } as any);
    await config.refreshAuth(AuthType.USE_GEMINI);
    await config.initialize();

    const chat = new GeminiChat(config);
    const latency = await runTurn(chat, `Read the file ${file}`);
    console.log(`Latency: ${latency.toFixed(2)}ms`);
    results.push({ mode: 'baseline', latency });
  }

  // 2. Warmup
  console.log('\n--- Running Warmup (Reuse ON - Cache Miss) ---');
  const cachePath = path.join(process.cwd(), '.gemini', 'cache', 'plans.json');
  try { await fs.unlink(cachePath); } catch (e) {}

  const reuseConfig = new Config({ ...baseConfigParams, enablePlanReuse: true } as any);
  await reuseConfig.refreshAuth(AuthType.USE_GEMINI);
  await reuseConfig.initialize();

  const reuseChat = new GeminiChat(reuseConfig);
  const trainLatency = await runTurn(reuseChat, `Read the file ${files[0]}`);
  console.log(`Warmup Latency: ${trainLatency.toFixed(2)}ms`);

  // 3. Experiment
  console.log('\n--- Running Experiment (Reuse ON - Cache Hit) ---');
  for (let i = 1; i < files.length; i++) {
    const file = files[i];
    const chat = new GeminiChat(reuseConfig);
    const latency = await runTurn(chat, `Read the file ${file}`);
    console.log(`Latency: ${latency.toFixed(2)}ms`);
    results.push({ mode: 'reuse', latency });
  }

  // Analysis
  const baseline = results.filter(r => r.mode === 'baseline');
  const reuse = results.filter(r => r.mode === 'reuse');
  const avgBaseline = baseline.reduce((a, b) => a + b.latency, 0) / baseline.length;
  const avgReuse = reuse.reduce((a, b) => a + b.latency, 0) / reuse.length;

  console.log(`\nAverage Baseline: ${avgBaseline.toFixed(2)}ms`);
  console.log(`Average Reuse:    ${avgReuse.toFixed(2)}ms`);
  const improvement = ((avgBaseline - avgReuse) / avgBaseline * 100);
  console.log(`Improvement:      ${improvement.toFixed(2)}%`);

  await fs.rm(tempDir, { recursive: true, force: true });
}

runBenchmark().catch(console.error);
