import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import {
  cleanAntigravityAssistantText,
  readAntigravityConversation,
} from '@/modules/providers/list/antigravity/antigravity-storage.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const createAntigravityConversationDatabase = async (
  filePath: string,
  workspacePath: string,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    db.exec(`
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type TEXT,
        metadata TEXT,
        step_payload TEXT
      );
    `);

    const insertStep = db.prepare(`
      INSERT INTO steps (idx, step_type, metadata, step_payload)
      VALUES (?, ?, ?, ?)
    `);

    insertStep.run(
      1,
      'user_message',
      JSON.stringify({ cwd: workspacePath, timestamp: '2026-06-30T00:00:00.000Z' }),
      JSON.stringify({ role: 'user', text: 'Build Antigravity support.' }),
    );
    insertStep.run(
      2,
      'assistant_message',
      JSON.stringify({ timestamp: '2026-06-30T00:00:01.000Z' }),
      JSON.stringify({ role: 'assistant', content: 'The provider is wired.\nrun_command:\nThe provider is wired.' }),
    );
    insertStep.run(
      3,
      'assistant_tool',
      JSON.stringify({ timestamp: '2026-06-30T00:00:02.000Z' }),
      JSON.stringify({ type: 'tool', name: 'read_file', content: 'internal tool echo' }),
    );
    insertStep.run(
      4,
      'assistant_message',
      JSON.stringify({ timestamp: '2026-06-30T00:00:03.000Z' }),
      JSON.stringify({ role: 'assistant', content: 'The provider is wired.' }),
    );
  } finally {
    db.close();
  }
};

const betterSqliteBindingsAvailable = (): boolean => {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
};

test('Antigravity conversation reader extracts safe history from sqlite steps', { concurrency: false }, async (t) => {
  if (!betterSqliteBindingsAvailable()) {
    t.skip('better-sqlite3 native bindings are unavailable in this Node runtime');
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'antigravity-session-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const conversationId = '123e4567-e89b-12d3-a456-426614174000';
  const conversationPath = path.join(
    tempRoot,
    '.gemini',
    'antigravity-cli',
    'conversations',
    `${conversationId}.db`,
  );
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await mkdir(workspacePath, { recursive: true });
    await createAntigravityConversationDatabase(conversationPath, workspacePath);

    const conversation = await readAntigravityConversation(conversationPath);

    assert.ok(conversation);
    assert.equal(conversation.conversationId, conversationId);
    assert.equal(conversation.projectPath, workspacePath);
    assert.equal(conversation.sessionName, 'Build Antigravity support.');
    assert.deepEqual(
      conversation.messages.map((message) => [message.role, message.content]),
      [
        ['user', 'Build Antigravity support.'],
        ['assistant', 'The provider is wired.'],
      ],
    );
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Antigravity sessions provider cleans live output fragments', () => {
  assert.equal(
    cleanAntigravityAssistantText('run_command:\nDone\nDone\n<|bot-marker|>'),
    'Done',
  );

  const provider = new AntigravitySessionsProvider();
  const normalized = provider.normalizeMessage({
    kind: 'stream_delta',
    conversationId: 'antigravity-live',
    content: 'write_file:\nResult text\nResult text',
  }, null);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.provider, 'antigravity');
  assert.equal(normalized[0]?.sessionId, 'antigravity-live');
  assert.equal(normalized[0]?.kind, 'stream_delta');
  assert.equal(normalized[0]?.content, 'Result text');
});
