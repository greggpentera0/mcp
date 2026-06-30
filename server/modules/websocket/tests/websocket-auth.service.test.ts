import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

function createVerifyInfo(url = '/ws?token=secret-token') {
  const request = {
    url,
    headers: {},
  } as AuthenticatedWebSocketRequest;

  return {
    req: request,
    origin: 'http://localhost',
    secure: false,
  };
}

test('auth-disabled websocket mode accepts a request without a token', () => {
  const info = createVerifyInfo('/ws');

  const accepted = verifyWebSocketClient(info, {
    isAuthDisabled: true,
    isPlatform: false,
    authenticateWebSocket: (token) => {
      assert.equal(token, null);
      return { id: 1, userId: 1, username: 'local-user' };
    },
  });

  assert.equal(accepted, true);
  assert.deepEqual(info.req.user, { id: 1, userId: 1, username: 'local-user' });
});

test('token websocket mode rejects a request when no user is returned', () => {
  const info = createVerifyInfo('/ws');

  const accepted = verifyWebSocketClient(info, {
    isAuthDisabled: false,
    isPlatform: false,
    authenticateWebSocket: (token) => {
      assert.equal(token, null);
      return null;
    },
  });

  assert.equal(accepted, false);
  assert.equal(info.req.user, undefined);
});

test('token websocket mode forwards query tokens to the authenticator', () => {
  const info = createVerifyInfo();

  const accepted = verifyWebSocketClient(info, {
    isAuthDisabled: false,
    isPlatform: false,
    authenticateWebSocket: (token) => {
      assert.equal(token, 'secret-token');
      return { id: 2, userId: 2, username: 'configured-user' };
    },
  });

  assert.equal(accepted, true);
  assert.deepEqual(info.req.user, { id: 2, userId: 2, username: 'configured-user' });
});
