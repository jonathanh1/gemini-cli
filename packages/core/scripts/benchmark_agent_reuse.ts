
import { Config } from '../src/config/config.js';
import { GeminiChat } from '../src/core/geminiChat.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Part } from '@google/genai';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { FunctionCallPart } from '@google/genai';

// Simple mock for tools if we don't want to run real tools,
// but for end-to-end we might want to use real tools or at least
// have the chat generate tool calls.
// Since we are measuring latency to *tool execution* (or tool generation),
// we need the model to actually generate the tool call.
// This requires a real API key.

async function runBenchmark() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error('Error: GOOGLE_API_KEY environment variable is required.');
    process.exit(1);
  }

  console.log('Starting AgentReuse Benchmark...');

  // Setup temp workspace
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-benchmark-'));
  console.log(`Workspace: ${tempDir}`);

  // Create dummy files for "different files" testing
  const files = ['utils.ts', 'helper.ts', 'api.ts', 'core.ts', 'main.ts'];
  for (const file of files) {
    await fs.writeFile(path.join(tempDir, file), `// content of ${file}\nexport const x = 1;`);
  }

  const commands = [
    { intent: 'read_file', template: 'Read the file {{file}}' },
    // Add more intents as needed
  ];

  const results: any[] = [];

  // Initialize Config
  const baseConfigParams = {
    sessionId: 'benchmark-session',
    targetDir: tempDir,
    debugMode: false,
    model: 'gemini-1.5-pro', // Standard model for reasoning
    enablePlanReuse: false,
  };

  // Helper to run a chat turn
  const runTurn = async (chat: GeminiChat, message: string): Promise<number> => {
    const start = performance.now();
    try {
        const stream = await chat.sendMessageStream({ model: 'gemini-1.5-pro' }, message, 'benchmark-prompt', new AbortController().signal);
        for await (const event of stream) {
            // We just consume the stream to trigger execution
        }
    } catch (e) {
        console.error(`Error processing "${message}":`, e);
    }
    const end = performance.now();
    return end - start;
  };

  // 1. Baseline (Reuse OFF)
  console.log('\n--- Running Baseline (Reuse OFF) ---');
  for (const file of files) {
    const config = new Config({ ...baseConfigParams, enablePlanReuse: false } as any);
    await config.initialize();
    const chat = new GeminiChat(config);

    const prompt = `Read the file ${file}`;
    process.stdout.write(`Executing: "${prompt}" ... `);
    const latency = await runTurn(chat, prompt);
    console.log(`${latency.toFixed(2)}ms`);

    results.push({
      mode: 'baseline',
      file,
      latency,
    });
  }

  // 2. Warmup (Reuse ON - First Run)
  console.log('\n--- Running Warmup (Reuse ON - Cache Miss) ---');
  // We need a persistent cache for reuse to work across instances,
  // but here we can reuse the same service instance if we keep the cache file.
  // The PlanReuseService uses a file in .gemini/cache/plans.json.
  // We should ensure we point to the SAME cache file.
  // The Config determines the project root. We are using `tempDir`.
  // PlanReuseService uses `process.cwd()` in the current implementation (oops).
  // We should probably fix PlanReuseService to use `config.targetDir` or `config.storage`.
  // For this script, we'll rely on the fact that we run in `process.cwd()`.

  // Note: The current implementation of PlanReuseService uses `process.cwd()/.gemini/...`
  // This means the cache is shared across runs in this directory.
  // We should clear the cache before starting.
  const cachePath = path.join(process.cwd(), '.gemini', 'cache', 'plans.json');
  try {
      await fs.unlink(cachePath);
  } catch (e) {}

  // Run the commands once to populate cache
  // We use the *same* prompts as baseline? No, we should use different files if we want to test generalization,
  // but we only have 5 files.
  // The hypothesis says: "Run each command 5 times with *different files* to test parameter generalization."
  // So we train on File A, test on File B?
  // Or simply: "Repetitive tasks".
  // If I "Read file A", then "Read file B", the intent is the same ("read_file").
  // So the first "Read file A" is the warmup (Cache Miss).
  // The second "Read file B" should be a Cache Hit (Plan Reuse).

  // Let's modify the flow:
  // 1. Train on `files[0]` ("Read utils.ts")
  // 2. Measure on `files[1..4]` ("Read helper.ts", etc.) -> These should be Hits.

  const reuseConfig = new Config({ ...baseConfigParams, enablePlanReuse: true } as any);
  await reuseConfig.initialize();
  const reuseChat = new GeminiChat(reuseConfig);

  const trainFile = files[0];
  console.log(`Training on: "Read ${trainFile}"`);
  await runTurn(reuseChat, `Read the file ${trainFile}`);

  // 3. Experiment (Reuse ON - Cache Hit)
  console.log('\n--- Running Experiment (Reuse ON - Cache Hit) ---');
  for (let i = 1; i < files.length; i++) {
    const file = files[i];
    const prompt = `Read the file ${file}`;
    process.stdout.write(`Executing: "${prompt}" ... `);

    // We need a fresh chat for each turn?
    // Usually the user might keep the session, but to isolate "latency of request",
    // we can use the same chat or new chat. Reuse service is global/file-based.
    // Using same chat adds history, which might affect routing.
    // Let's use a new chat instance to simulate a fresh command or at least clean history.
    const runChat = new GeminiChat(reuseConfig);
    const latency = await runTurn(runChat, prompt);
    console.log(`${latency.toFixed(2)}ms`);

    results.push({
      mode: 'reuse',
      file,
      latency,
    });
  }

  // Analysis
  console.log('\n--- Analysis ---');
  const baseline = results.filter(r => r.mode === 'baseline');
  const reuse = results.filter(r => r.mode === 'reuse');

  const avgBaseline = baseline.reduce((a, b) => a + b.latency, 0) / baseline.length;
  const avgReuse = reuse.reduce((a, b) => a + b.latency, 0) / reuse.length;

  console.log(`Average Baseline Latency: ${avgBaseline.toFixed(2)}ms`);
  console.log(`Average Reuse Latency:    ${avgReuse.toFixed(2)}ms`);
  console.log(`Improvement:              ${((avgBaseline - avgReuse) / avgBaseline * 100).toFixed(2)}%`);

  // Cleanup
  await fs.rm(tempDir, { recursive: true, force: true });
}

runBenchmark().catch(console.error);
