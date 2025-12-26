# AgentReuse: Retrieval-Augmented Planning

The "AgentReuse" feature reduces latency and token costs for repetitive tasks by caching successful execution plans and reusing them as hints for future requests.

## How It Works

1.  **Learn:** When you run a command successfully, the system saves the "Plan" (User Intent + Tool Call) to a local cache.
2.  **Reuse:** When you run a similar command later, the system retrieves the cached plan and injects it into the prompt as a **System Hint**.
3.  **Result:** The Main Model sees the hint and skips the heavy "reasoning" phase, executing the tool immediately.

## 1. Enable the Feature

This is an experimental feature. Enable it in your configuration file (e.g., `~/.config/gemini/config.yml`):

```yaml
experimental:
  enablePlanReuse: true
```

## 2. Verify Functionality

### Phase 1: Learning (Cache Miss)
Run a specific command. The system will execute it normally and learn the plan.

```bash
gemini -p "List all files in the packages/core directory"
```

*Status:* The system routes the request, generates a plan using the Main Model, executes it, and saves it to `.gemini/cache/plans.json`.

### Phase 2: Reuse (Cache Hit)
Run the **same** (or very similar) command again.

```bash
gemini -p "List all files in the packages/core directory"
```

*Status:* The system detects the cached plan. It injects a hint into the prompt:
`[System Hint: A similar successful plan was found for this request. Consider using tool "ls" with arguments: ...]`

The Main Model adopts this plan instantly, reducing latency.

## 3. Debugging & Verification

*   **Check the Cache:** Inspect `.gemini/cache/plans.json` to see stored plans.
*   **Debug Logs:** Run with `--debug` to see the injected hint in the prompt.
    ```bash
    gemini --debug -p "List all files..."
    ```
