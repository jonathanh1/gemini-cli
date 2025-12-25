/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { distance } from 'ml-distance';
import { Config } from '../config/config.js';
import { ContentEmbedding, FunctionCallPart, Part, Tool } from '@google/genai';
import {
  GenerateContentConfig,
  GoogleGenerativeAI,
} from '@google/genai';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from '../config/models.js';

export interface CachedPlan {
  intentLabel: string;
  embedding: number[];
  canonicalRequest: string;
  planTemplate: ToolCallTemplate[];
  usageCount: number;
  originalRequest?: string; // For debugging
  timestamp: number;
}

export interface ToolCallTemplate {
  name: string;
  args: Record<string, unknown>; // Args with {{placeholders}}
}

export interface RouterOutput {
  intent: string;
  parameters: Record<string, string>;
  canonicalRequest: string;
}

export interface MatchResult {
  hit: boolean;
  plan?: CachedPlan;
  parameters?: Record<string, string>;
  hydratedToolCalls?: FunctionCallPart[];
}

const ROUTER_MODEL = 'gemini-3-flash-preview';
const CACHE_FILE_NAME = 'plans.json';
const SIMILARITY_THRESHOLD = 0.75;

export class PlanReuseService {
  private cache: CachedPlan[] = [];
  private cacheLoaded = false;
  private cachePath: string;
  private genaiClient: GoogleGenerativeAI;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    const cacheDir = path.join(config.storage.getProjectTempDir(), 'cache'); // Using temp dir for now, or should it be persistent?
    // The plan says ".gemini/cache/plans.db" (or json). The config.storage usually handles ".gemini" folder.
    // Let's check where to put it. Usually CLI tools use a persistent user data dir or a local project dir.
    // Assuming local project .gemini folder for now.
    // The prompt says ".gemini/cache/plans.db".
    this.cachePath = path.join(process.cwd(), '.gemini', 'cache', CACHE_FILE_NAME);

    // Initialize GenAI client
    // We need to use the apiKey from the config.
    // Assuming we can get the apiKey or construct a client.
    // Config doesn't expose apiKey directly sometimes.
    // But we can use the ContentGenerator or create a new client.
    // Let's reuse the config to get the apiKey if possible, or assume the environment is set up.
    // Looking at `packages/core/src/core/client.ts`, it uses `config.getParams().apiKey`.
    const apiKey = config.getParams().apiKey || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      // If we can't find an API key, we might need to rely on the existing client logic.
      // But for this service, we'll try to instantiate a lightweight client if we can.
      // If not, we might fail to route.
      console.warn('PlanReuseService: No API Key found, routing will be disabled.');
    }
    this.genaiClient = new GoogleGenerativeAI(apiKey || 'dummy');
  }

  async initialize(): Promise<void> {
    if (this.cacheLoaded) return;
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      const data = await fs.readFile(this.cachePath, 'utf-8');
      this.cache = JSON.parse(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Failed to load plan cache:', error);
      }
      this.cache = [];
    }
    this.cacheLoaded = true;
  }

  async findMatch(userRequest: string): Promise<MatchResult> {
    await this.initialize();
    if (this.cache.length === 0) return { hit: false };

    try {
      // 1. Router: Get Intent and Canonical Request
      const routerOutput = await this.routeRequest(userRequest);
      if (!routerOutput) return { hit: false };

      // 2. Embed Canonical Request
      const embedding = await this.getEmbedding(routerOutput.canonicalRequest);
      if (!embedding) return { hit: false };

      // 3. Search Vector Space
      let bestMatch: CachedPlan | undefined;
      let maxSimilarity = -1;

      for (const plan of this.cache) {
        // ml-distance cosine is distance (1 - similarity? or just distance?)
        // ml-distance exports 'similarity.cosine' usually.
        // Wait, 'ml-distance' documentation says `distance.cosine`.
        // Cosine distance = 1 - Cosine Similarity.
        // So Similarity = 1 - Distance.
        const dist = distance.cosine(embedding, plan.embedding);
        const similarity = 1 - dist;

        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          bestMatch = plan;
        }
      }

      if (maxSimilarity > SIMILARITY_THRESHOLD && bestMatch) {
        // Hit!
        // 4. Hydrate
        const toolCalls = this.hydrateTemplate(bestMatch.planTemplate, routerOutput.parameters);
        bestMatch.usageCount++;
        // Fire and forget save to update usage count
        this.saveCache().catch(console.error);

        return {
          hit: true,
          plan: bestMatch,
          parameters: routerOutput.parameters,
          hydratedToolCalls: toolCalls,
        };
      }

      return { hit: false };

    } catch (error) {
      console.error('PlanReuseService findMatch error:', error);
      return { hit: false };
    }
  }

  async routeRequest(userRequest: string): Promise<RouterOutput | null> {
    const systemPrompt = `You are the Intent Classifier for an AI coding assistant. Your job is to normalize user requests into a canonical form for caching.
Analyze the user's prompt and extract:
1. Intent: A snake_case action name (e.g., read_file, fix_lint, explain_code).
2. Parameters: A JSON object of specific variables (filenames, branch names, error messages) found in the prompt.
3. CanonicalRequest: The user's prompt rewritten without specific parameters. Use generic terms (e.g., replace "utils.ts" with "a file", "master" with "a branch").

Output JSON:
{ "intent": string, "parameters": object, "canonicalRequest": string }`;

    try {
      const model = this.genaiClient.getGenerativeModel({
        model: ROUTER_MODEL,
        systemInstruction: systemPrompt,
        generationConfig: {
          responseMimeType: 'application/json',
        }
      });

      const result = await model.generateContent(userRequest);
      const text = result.response.text();
      if (!text) return null;
      return JSON.parse(text) as RouterOutput;
    } catch (error) {
      // Fallback if ROUTER_MODEL fails?
      console.warn('PlanReuseService routing failed:', error);
      return null;
    }
  }

  async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const model = this.genaiClient.getGenerativeModel({
        model: this.config.getEmbeddingModel() || DEFAULT_GEMINI_EMBEDDING_MODEL,
      });
      const result = await model.embedContent(text);
      const values = result.embedding?.values;
      if (values) {
        // Convert Float32Array to number[] if needed, ml-distance handles arrays.
        return Array.from(values);
      }
      return null;
    } catch (error) {
      console.warn('PlanReuseService embedding failed:', error);
      return null;
    }
  }

  hydrateTemplate(template: ToolCallTemplate[], parameters: Record<string, string>): FunctionCallPart[] {
    return template.map(tool => {
      const hydratedArgs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(tool.args)) {
        if (typeof value === 'string') {
          // Simple replacement for now. Recursive if needed.
          let newValue = value;
          for (const [paramKey, paramValue] of Object.entries(parameters)) {
             // Replace {{paramKey}} with paramValue
             newValue = newValue.replace(new RegExp(`{{${paramKey}}}`, 'g'), paramValue);
          }
          hydratedArgs[key] = newValue;
        } else {
          hydratedArgs[key] = value;
        }
      }
      return {
        functionCall: {
          name: tool.name,
          args: hydratedArgs,
        }
      };
    });
  }

  async savePlan(userRequest: string, toolCalls: FunctionCallPart[]): Promise<void> {
    await this.initialize();

    // Deduplication check: Check if an identical request already exists (simple heuristic)
    // or if we have a very high similarity match.
    // For MVP, checking originalRequest might be too specific (it changes),
    // but canonicalRequest might be stable.
    // However, we don't have canonicalRequest yet.
    // Let's first check if we already have a plan with this EXACT userRequest cached?
    // Unlikely if parameters change.

    // Better: We proceed to route/embed, then check if we already have a similar plan.

    // We need to route the original request again to get the canonical form and params
    // so we can generalize the tool calls.
    const routerOutput = await this.routeRequest(userRequest);
    if (!routerOutput) return;

    // Check if we already have a plan with this canonical request
    const existingPlan = this.cache.find(p => p.canonicalRequest === routerOutput.canonicalRequest);
    if (existingPlan) {
      // Already exists. Maybe update usage count?
      // But we are in "savePlan" which implies learning a new plan.
      // If it exists, we don't need to add it again.
      return;
    }

    const embedding = await this.getEmbedding(routerOutput.canonicalRequest);
    if (!embedding) return;

    // Check similarity to avoid near-duplicates
    for (const plan of this.cache) {
      const dist = distance.cosine(embedding, plan.embedding);
      const similarity = 1 - dist;
      if (similarity > 0.98) { // Very high threshold for "duplicate"
         // Already covered.
         return;
      }
    }

    // Generalize tool calls
    const planTemplate = this.generalizeToolCalls(toolCalls, routerOutput.parameters);

    const newPlan: CachedPlan = {
      intentLabel: routerOutput.intent,
      embedding: embedding,
      canonicalRequest: routerOutput.canonicalRequest,
      planTemplate: planTemplate,
      usageCount: 1,
      originalRequest: userRequest,
      timestamp: Date.now(),
    };

    this.cache.push(newPlan);
    await this.saveCache();
  }

  generalizeToolCalls(toolCalls: FunctionCallPart[], parameters: Record<string, string>): ToolCallTemplate[] {
    // Reverse hydration: find parameter values in tool args and replace with {{key}}
    return toolCalls.map(tc => {
      const args = tc.functionCall?.args || {};
      const generalizedArgs: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string') {
           let newValue = value;
           // We need to be careful with overlapping values.
           // Maybe sort parameters by length descending to avoid partial replacements?
           const sortedParams = Object.entries(parameters).sort((a, b) => b[1].length - a[1].length);

           for (const [paramKey, paramValue] of sortedParams) {
             if (newValue.includes(paramValue)) {
               newValue = newValue.replace(new RegExp(this.escapeRegExp(paramValue), 'g'), `{{${paramKey}}}`);
             }
           }
           generalizedArgs[key] = newValue;
        } else {
           generalizedArgs[key] = value;
        }
      }

      return {
        name: tc.functionCall?.name || 'unknown',
        args: generalizedArgs,
      };
    });
  }

  private escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
  }

  private async saveCache(): Promise<void> {
    try {
      await fs.writeFile(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      console.error('Failed to save plan cache:', error);
    }
  }
}
