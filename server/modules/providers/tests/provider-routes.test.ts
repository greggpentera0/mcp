import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import providerRoutes from '@/modules/providers/provider.routes.js';

type JsonResponse = {
  status: number;
  body: Record<string, unknown>;
};

const requestProviderRoute = async (
  path: string,
  options: RequestInit = {},
): Promise<JsonResponse> => {
  const app = express();
  app.use(express.json());
  app.use('/api/providers', providerRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const typedError = error as { statusCode?: number; code?: string; message?: string };
    res.status(typedError.statusCode ?? 500).json({
      success: false,
      error: {
        code: typedError.code ?? 'INTERNAL_ERROR',
        message: typedError.message ?? 'Unknown error',
      },
    });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/providers${path}`, options);
    const body = await response.json() as Record<string, unknown>;
    return {
      status: response.status,
      body,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
};

test('provider routes accept antigravity through the shared registry', async () => {
  const response = await requestProviderRoute('/antigravity/capabilities');
  const data = response.body.data as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(data.provider, 'antigravity');
  assert.deepEqual(data.permissionModes, ['default', 'bypassPermissions']);
});

test('provider routes reject unsupported providers from the shared registry', async () => {
  const response = await requestProviderRoute('/not-real/capabilities');
  const error = response.body.error as Record<string, unknown>;

  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.equal(error.code, 'UNSUPPORTED_PROVIDER');
});

test('provider routes reject unsafe session ids before changing models', async () => {
  const response = await requestProviderRoute('/antigravity/sessions/bad%20id/active-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'Gemini 3.5 Flash (Medium)' }),
  });
  const error = response.body.error as Record<string, unknown>;

  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
  assert.equal(error.code, 'INVALID_SESSION_ID');
});
