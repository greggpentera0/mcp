import { spawn } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { getAntigravityExecutable } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
    { value: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)' },
    { value: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash (Low)' },
    { value: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' },
    { value: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro (Low)' },
  ],
  DEFAULT: 'Gemini 3.5 Flash (Medium)',
};

const ANTIGRAVITY_MODELS_TIMEOUT_MS = 15_000;
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

const parseAntigravityModelsStdout = (stdout: string): ProviderModelOption[] => {
  const options = new Map<string, ProviderModelOption>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^[\s*>\-•]+/, '')
      .replace(/\s+\(default\)$/i, '')
      .trim();
    if (!line || /^(available\s+)?models:?$/i.test(line)) {
      continue;
    }

    const [valuePart, descriptionPart] = line.split(/\s{2,}/, 2);
    const value = valuePart.trim();
    if (!value || value.length > 160) {
      continue;
    }

    options.set(value, {
      value,
      label: value,
      description: descriptionPart?.trim() || undefined,
    });
  }

  return [...options.values()];
};

const runAntigravityModelsCommand = (): Promise<string> => new Promise((resolve, reject) => {
  const agyProcess = spawnFunction(getAntigravityExecutable(), ['models'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    agyProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error('agy models timed out'));
    }
  }, ANTIGRAVITY_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);

    if (error) {
      reject(error);
      return;
    }

    resolve(output);
  };

  agyProcess.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  agyProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  agyProcess.on('error', (error) => {
    finish(error instanceof Error ? error : new Error(String(error)), '');
  });

  agyProcess.on('close', (code) => {
    if (code !== 0) {
      finish(new Error(stderr.trim() || `agy models exited with code ${code}`), '');
      return;
    }

    finish(null, stdout);
  });
});

export class AntigravityProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const stdout = await runAntigravityModelsCommand();
      const options = parseAntigravityModelsStdout(stdout);
      if (options.length === 0) {
        return ANTIGRAVITY_FALLBACK_MODELS;
      }

      const fallbackDefault = ANTIGRAVITY_FALLBACK_MODELS.DEFAULT;
      return {
        OPTIONS: options,
        DEFAULT: options.some((option) => option.value === fallbackDefault)
          ? fallbackDefault
          : options[0].value,
      };
    } catch {
      return ANTIGRAVITY_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('antigravity', input);
  }
}
