import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveCursorAgentExecutablePath,
  type ResolveCursorAgentExecutablePathDependencies,
} from '@/shared/cursor-cli-path.js';

function createAccessSync(existingPath: string): typeof fs.accessSync {
  return ((candidate) => {
    if (String(candidate) !== existingPath) {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
  }) as typeof fs.accessSync;
}

function createMissingAccessSync(): typeof fs.accessSync {
  return (() => {
    const error = new Error('missing') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  }) as typeof fs.accessSync;
}

test('resolveCursorAgentExecutablePath uses CURSOR_AGENT_PATH when configured', () => {
  const resolved = resolveCursorAgentExecutablePath(undefined, {
    env: { CURSOR_AGENT_PATH: ' "/tools/cursor-agent" ' },
    platform: 'darwin',
  });

  assert.equal(resolved, '/tools/cursor-agent');
});

test('resolveCursorAgentExecutablePath resolves cursor-agent from PATH', () => {
  const binDir = path.join(os.tmpdir(), 'cursor-agent-bin');
  const expectedPath = path.join(binDir, 'cursor-agent');

  const resolved = resolveCursorAgentExecutablePath(undefined, {
    accessSync: createAccessSync(expectedPath),
    env: { PATH: binDir },
    platform: 'darwin',
  });

  assert.equal(resolved, expectedPath);
});

test('resolveCursorAgentExecutablePath falls back to user-local Cursor install', () => {
  const homeDir = path.join(os.tmpdir(), 'cursor-agent-home');
  const expectedPath = path.join(homeDir, '.local', 'bin', 'cursor-agent');

  const resolved = resolveCursorAgentExecutablePath(undefined, {
    accessSync: createAccessSync(expectedPath),
    env: { PATH: '/bin' },
    homedir: () => homeDir,
    platform: 'darwin',
  });

  assert.equal(resolved, expectedPath);
});

test('resolveCursorAgentExecutablePath returns the command name when no executable is found', () => {
  const deps: ResolveCursorAgentExecutablePathDependencies = {
    accessSync: createMissingAccessSync(),
    env: { PATH: '/bin' },
    homedir: () => path.join(os.tmpdir(), 'missing-cursor-agent-home'),
    platform: 'darwin',
  };

  assert.equal(resolveCursorAgentExecutablePath(undefined, deps), 'cursor-agent');
});
