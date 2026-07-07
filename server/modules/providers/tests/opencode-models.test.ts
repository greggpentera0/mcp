import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildOpenCodeRuntimeEnv,
  buildOpenCodeConfigModelsDefinition,
  getOpenCodeExecutable,
  readOpenCodeConfigModels,
} from '@/modules/providers/list/opencode/opencode-config.js';
import {
  OpenCodeProviderModels,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const patchCurrentDirectory = (nextCwd: string) => {
  const original = process.cwd();
  process.chdir(nextCwd);
  return () => {
    process.chdir(original);
  };
};

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
  const restoreCwd = patchCurrentDirectory(tempRoot);

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
      OPTIONS: [],
      DEFAULT: '',
    });
    assert.equal(definition.DEFAULT, 'ollama/qwen3-coder:latest');
  } finally {
    restoreCwd();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode config models parser discovers app-root opencode.json', { concurrency: false }, async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'opencode-config-home-'));
  const tempAppRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-config-app-root-'));
  const restoreHomeDir = patchHomeDir(tempHome);
  const restoreCwd = patchCurrentDirectory(tempAppRoot);
  const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;

  try {
    delete process.env.OPENCODE_CONFIG;
    const globalConfigDir = path.join(tempHome, '.config', 'opencode');
    await mkdir(globalConfigDir, { recursive: true });
    await writeFile(path.join(globalConfigDir, 'opencode.jsonc'), '{ "provider": {} }\n', 'utf8');

    const appConfigPath = path.join(tempAppRoot, 'opencode.json');
    await writeFile(
      appConfigPath,
      `{
        "model": "ollama/qwen3-coder:30b",
        "provider": {
          "ollama": {
            "name": "Ollama (local)",
            "models": {
              "qwen3-coder:30b": { "name": "Qwen3 Coder 30B (local)" }
            }
          }
        }
      }\n`,
      'utf8',
    );

    const expectedAppConfigPath = path.join(fs.realpathSync(tempAppRoot), 'opencode.json');
    const configModels = await readOpenCodeConfigModels();
    assert.ok(configModels);
    assert.equal(configModels.filePath, expectedAppConfigPath);
    assert.equal(configModels.defaultModel, 'ollama/qwen3-coder:30b');
    assert.deepEqual(configModels.models, [
      {
        value: 'ollama/qwen3-coder:30b',
        label: 'Qwen3 Coder 30B (local)',
        description: 'Ollama (local) - ollama/qwen3-coder:30b',
      },
    ]);

    const runtimeEnv = await buildOpenCodeRuntimeEnv({});
    assert.equal(runtimeEnv.OPENCODE_CONFIG, expectedAppConfigPath);
  } finally {
    if (previousOpenCodeConfig === undefined) {
      delete process.env.OPENCODE_CONFIG;
    } else {
      process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
    }

    restoreCwd();
    restoreHomeDir();
    await rm(tempAppRoot, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  }
});

test('OpenCode config models parser filters missing local Ollama models', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-config-local-models-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreCwd = patchCurrentDirectory(tempRoot);
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

    const definition = buildOpenCodeConfigModelsDefinition(configModels, {
      OPTIONS: [],
      DEFAULT: '',
    });
    assert.equal(definition.DEFAULT, '');
    assert.deepEqual(definition.OPTIONS, []);
  } finally {
    restoreCwd();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode models provider returns an empty catalog without local config models', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-empty-local-models-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreCwd = patchCurrentDirectory(tempRoot);

  try {
    const provider = new OpenCodeProviderModels();
    const definition = await provider.getSupportedModels();

    assert.deepEqual(definition, {
      OPTIONS: [],
      DEFAULT: '',
    });
  } finally {
    restoreCwd();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode models provider exposes validated local config models only', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-provider-local-models-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  const restoreCwd = patchCurrentDirectory(tempRoot);
  const originalFetch = globalThis.fetch;

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

    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen3-coder:latest' },
        ],
      }),
    })) as unknown as typeof fetch;

    const provider = new OpenCodeProviderModels();
    const definition = await provider.getSupportedModels();

    assert.equal(definition.DEFAULT, 'ollama/qwen3-coder:latest');
    assert.deepEqual(definition.OPTIONS, [
      {
        value: 'ollama/qwen3-coder:latest',
        label: 'Qwen 3 Coder (Local)',
        description: 'Ollama - ollama/qwen3-coder:latest',
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreCwd();
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
