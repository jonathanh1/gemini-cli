/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlanReuseService } from './planReuseService.js';
import { Config } from '../config/config.js';
import * as fs from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';

// Mock GoogleGenerativeAI
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(),
  FunctionCallPart: vi.fn(),
  Part: vi.fn(),
  ThinkingLevel: { HIGH: 'HIGH' }, // Mock ThinkingLevel
  Type: { OBJECT: 'OBJECT', STRING: 'STRING' }, // Mock Type
}));

describe('PlanReuseService', () => {
  let service: PlanReuseService;
  let mockConfig: Config;
  let mockGenAI: any;
  let mockModel: any;

  beforeEach(() => {
    mockConfig = {
      storage: {
        getProjectTempDir: () => '/tmp/gemini',
      },
      getParams: () => ({ apiKey: 'test-key' }),
      getEmbeddingModel: () => 'test-embedding-model',
      getContentGeneratorConfig: () => ({ apiKey: 'test-key' }),
    } as unknown as Config;

    mockModel = {
      generateContent: vi.fn(),
      embedContent: vi.fn(),
    };

    mockGenAI = {
      getGenerativeModel: vi.fn().mockReturnValue(mockModel),
    };

    (GoogleGenAI as unknown as any).mockImplementation(() => mockGenAI);

    service = new PlanReuseService(mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('routeRequest', () => {
    it('should parse router response correctly', async () => {
      const mockResponse = {
        intent: 'read_file',
        parameters: { file: 'test.ts' },
        canonicalRequest: 'read a file',
      };

      mockModel.generateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify(mockResponse),
        },
      });

      const result = await service.routeRequest('read test.ts');
      expect(result).toEqual(mockResponse);
      expect(mockGenAI.getGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-3-flash-preview' })
      );
    });

    it('should return null on JSON parse error', async () => {
      mockModel.generateContent.mockResolvedValue({
        response: {
          text: () => 'invalid json',
        },
      });

      const result = await service.routeRequest('test');
      expect(result).toBeNull();
    });
  });

  describe('getEmbedding', () => {
    it('should return embedding array', async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      mockModel.embedContent.mockResolvedValue({
        embedding: { values: mockEmbedding },
      });

      const result = await service.getEmbedding('test');
      expect(result).toEqual(mockEmbedding);
      expect(mockGenAI.getGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'test-embedding-model' })
      );
    });

    it('should return null on error', async () => {
      mockModel.embedContent.mockRejectedValue(new Error('fail'));
      const result = await service.getEmbedding('test');
      expect(result).toBeNull();
    });
  });

  describe('generalizeToolCalls', () => {
    it('should replace parameters with placeholders', () => {
      const toolCalls = [
        {
          functionCall: {
            name: 'read_file',
            args: { path: 'src/utils.ts' },
          },
        },
      ] as any[];

      const parameters = { file: 'src/utils.ts' };

      const templates = service.generalizeToolCalls(toolCalls, parameters);

      expect(templates).toHaveLength(1);
      expect(templates[0].args['path']).toBe('{{file}}');
    });

    it('should handle partial matches correctly', () => {
       const toolCalls = [
        {
          functionCall: {
            name: 'commit',
            args: { message: 'fix: update utils.ts' },
          },
        },
      ] as any[];

      const parameters = { file: 'utils.ts' };

      const templates = service.generalizeToolCalls(toolCalls, parameters);

      expect(templates[0].args['message']).toBe('fix: update {{file}}');
    });
  });

  describe('hydrateTemplate', () => {
    it('should replace placeholders with values', () => {
      const template = [
        {
          name: 'read_file',
          args: { path: '{{file}}' },
        },
      ];

      const parameters = { file: 'main.ts' };

      const hydrated = service.hydrateTemplate(template, parameters);

      expect(hydrated).toHaveLength(1);
      expect(hydrated[0].functionCall?.args?.['path']).toBe('main.ts');
    });
  });
});
