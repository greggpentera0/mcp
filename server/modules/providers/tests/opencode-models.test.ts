import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildOpenCodeConfigModelsDefinition,
  getOpenCodeExecutable,
  readOpenCodeConfigModels,
} from '@/modules/providers/list/opencode/opencode-config.js';
import {
  buildOpenCodeDefinitionFromIds,
  mergeOpenCodeModels,
  parseOpenCodeModelsStdout,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

test('OpenCode models provider parses plain CLI output and removes duplicates', () => {
  const ids = parseOpenCodeModelsStdout(`
opencode/big-pickle
not a model
anthropic/claude-opus-4-7-fast
anthropic/claude-opus-4-7-fast
openai/gpt-5.5-pro
`);

  assert.deepEqual(ids, [
    'opencode/big-pickle',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.5-pro',
  ]);
});

test('OpenCode models provider formats frontend labels from provider-prefixed ids', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'opencode/deepseek-v4-flash-free',
    'opencode/nemotron-3-super-free',
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.4-mini-fast',
    'openai/gpt-5.5-pro',
    'newprovider/alpha-v12-special-20261231',
  ]);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'Deepseek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
    },
    {
      value: 'opencode/nemotron-3-super-free',
      label: 'Nemotron 3 Super Free',
      description: 'opencode - opencode/nemotron-3-super-free',
    },
    {
      value: 'anthropic/claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet (2024-10-22)',
      description: 'anthropic - anthropic/claude-3-5-sonnet-20241022',
    },
    {
      value: 'anthropic/claude-opus-4-7-fast',
      label: 'Claude Opus 4.7 Fast',
      description: 'anthropic - anthropic/claude-opus-4-7-fast',
    },
    {
      value: 'openai/gpt-5.4-mini-fast',
      label: 'GPT-5.4 Mini Fast',
      description: 'openai - openai/gpt-5.4-mini-fast',
    },
    {
      value: 'openai/gpt-5.5-pro',
      label: 'GPT-5.5 Pro',
      description: 'openai - openai/gpt-5.5-pro',
    },
    {
      value: 'newprovider/alpha-v12-special-20261231',
      label: 'Alpha V12 Special (2026-12-31)',
      description: 'newprovider - newprovider/alpha-v12-special-20261231',
    },
  ]);
});

test('OpenCode executable resolver uses OPENCODE_PATH when configured', () => {
  const resolved = getOpenCodeExecutable({
    env: { OPENCODE_PATH: ' "/tools/opencode" ' },
    existsSync: () => false,
    accessSync: (() => {
      throw new Error('configured path should not check fallback locations');
    }) as typeof fs.accessSync,
    homedir: () => '/Users/example',
    platform: 'darwin',
  });

  assert.equal(resolved, '/tools/opencode');
});

test('OpenCode executable resolver falls back to the Homebrew binary location on macOS', () => {
  const homebrewPath = path.join(path.sep, 'opt', 'homebrew', 'bin', 'opencode');
  const checkedCandidates: string[] = [];

  const resolved = getOpenCodeExecutable({
    env: { PATH: '/usr/bin:/bin' },
    existsSync: () => false,
    accessSync: ((candidate) => {
      checkedCandidates.push(String(candidate));
      if (candidate === homebrewPath) {
        return;
      }

      throw Object.assign(new Error('not executable'), { code: 'ENOENT' });
    }) as typeof fs.accessSync,
    homedir: () => '/Users/example',
    platform: 'darwin',
  });

  assert.equal(resolved, homebrewPath);
  assert.deepEqual(checkedCandidates, [
    path.join('/Users/example', '.local', 'bin', 'opencode'),
    homebrewPath,
  ]);
});

test('OpenCode config models parser preserves local Ollama ids and default model', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-config-models-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const configDir = path.join(tempRoot, '.config', 'opencode');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, 'opencode.jsonc'),
      `{
        // Local model preference should be accepted.
        "model": "ollama/qwen3-coder:latest",
        "provider": {
          "ollama": {
            "name": "Ollama",
            "models": {
              "qwen3-coder:latest": { "name": "Qwen 3 Coder (Local)" },
              "gemma4:latest": { "name": "Gemma 4 (Local)" },
            },
          },
        },
      }\n`,
      'utf8',
    );

    const configModels = await readOpenCodeConfigModels();
    assert.ok(configModels);
    assert.equal(configModels.defaultModel, 'ollama/qwen3-coder:latest');
    assert.deepEqual(configModels.models, [
      {
        value: 'ollama/qwen3-coder:latest',
        label: 'Qwen 3 Coder (Local)',
        description: 'Ollama - ollama/qwen3-coder:latest',
      },
      {
        value: 'ollama/gemma4:latest',
        label: 'Gemma 4 (Local)',
        description: 'Ollama - ollama/gemma4:latest',
      },
    ]);

    const definition = buildOpenCodeConfigModelsDefinition(configModels, {
      OPTIONS: [{ value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
      DEFAULT: 'anthropic/claude-sonnet-4-5',
    });
    assert.equal(definition.DEFAULT, 'ollama/qwen3-coder:latest');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode config models parser filters missing local Ollama models', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-config-local-models-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  const requestedUrls: string[] = [];

  try {
    await writeFile(
      path.join(tempRoot, 'opencode.json'),
      `{
        "model": "ollama/qwen3-coder:latest",
        "provider": {
          "ollama": {
            "name": "Ollama",
            "options": {
              "baseURL": "http://127.0.0.1:11434/v1"
            },
            "models": {
              "qwen3-coder:latest": { "name": "Qwen 3 Coder (Local)" },
              "gemma4:latest": { "name": "Gemma 4 (Local)" }
            }
          }
        }
      }\n`,
      'utf8',
    );

    const configModels = await readOpenCodeConfigModels({
      validateLocalModels: true,
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return {
          ok: true,
          json: async () => ({ models: [] }),
        };
      },
    });

    assert.ok(configModels);
    assert.equal(configModels.defaultModel, 'ollama/qwen3-coder:latest');
    assert.deepEqual(configModels.models, []);
    assert.deepEqual(requestedUrls, ['http://127.0.0.1:11434/api/tags']);

    const definition = mergeOpenCodeModels(
      configModels,
      buildOpenCodeDefinitionFromIds(['opencode/big-pickle']),
    );
    assert.equal(definition.DEFAULT, 'opencode/big-pickle');
    assert.deepEqual(definition.OPTIONS.map((option) => option.value), ['opencode/big-pickle']);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
