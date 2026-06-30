import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

export const getAntigravityExecutable = (): string =>
  process.env.ANTIGRAVITY_PATH?.trim() || 'agy';

const runAntigravityCheck = (args: string[]): { ok: boolean; error?: string } => {
  try {
    const result = spawn.sync(getAntigravityExecutable(), args, {
      stdio: 'pipe',
      timeout: 10_000,
      env: { ...process.env },
    });

    if (result.error) {
      return { ok: false, error: result.error.message };
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim();
      const stdout = result.stdout?.toString().trim();
      return { ok: false, error: stderr || stdout || `agy ${args.join(' ')} exited with code ${result.status}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to run Antigravity CLI' };
  }
};

export class AntigravityProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = runAntigravityCheck(['--version']);
    if (!installed.ok) {
      return {
        installed: false,
        provider: 'antigravity',
        authenticated: false,
        email: null,
        method: null,
        error: installed.error || 'Antigravity CLI is not installed',
      };
    }

    const authenticated = runAntigravityCheck(['models']);
    return {
      installed: true,
      provider: 'antigravity',
      authenticated: authenticated.ok,
      email: authenticated.ok ? 'Antigravity CLI' : null,
      method: authenticated.ok ? 'cli' : null,
      error: authenticated.ok ? undefined : authenticated.error || 'Antigravity CLI is not authenticated',
    };
  }
}
