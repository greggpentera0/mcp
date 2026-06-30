import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeAuthStatusStdout } from '@/modules/providers/list/claude/claude-auth.provider.js';

test('Claude auth parser accepts current CLI JSON status output', () => {
  const status = parseClaudeAuthStatusStdout(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'person@example.com',
    orgId: 'org-id-not-returned',
    orgName: 'Example Org',
    subscriptionType: 'pro',
  }));

  assert.deepEqual(status, {
    authenticated: true,
    email: 'person@example.com',
    method: 'claude.ai',
  });
});

test('Claude auth parser reports unauthenticated CLI JSON status output', () => {
  const status = parseClaudeAuthStatusStdout(JSON.stringify({
    loggedIn: false,
    authMethod: null,
    apiProvider: null,
  }));

  assert.deepEqual(status, {
    authenticated: false,
    email: null,
    method: null,
    error: 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.',
  });
});

test('Claude auth parser ignores unsupported output so legacy checks can run', () => {
  assert.equal(parseClaudeAuthStatusStdout('not json'), null);
  assert.equal(parseClaudeAuthStatusStdout(JSON.stringify({ authenticated: true })), null);
});
