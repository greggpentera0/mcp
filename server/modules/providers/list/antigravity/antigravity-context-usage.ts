import path from 'node:path';

import pty from 'node-pty';

import { getAntigravityExecutable } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';

export type AntigravityContextUsage = {
  used: number;
  total: number;
  freeSpace?: number;
  checkpointBuffer?: number;
  inputTokens?: number;
  outputTokens?: number;
  breakdown: {
    input: number;
    output: number;
    toolCalls?: number;
    systemPrompt?: number;
    systemTools?: number;
    skills?: number;
    subagents?: number;
  };
  source: 'antigravity_context';
};

type CacheEntry = {
  expiresAt: number;
  usage: AntigravityContextUsage;
};

const CACHE_TTL_MS = 30_000;
const CONTEXT_COMMAND_TIMEOUT_MS = 5_000;
const usageCache = new Map<string, CacheEntry>();

const parseNumber = (value: string | undefined): number => {
  if (!value) {
    return 0;
  }

  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const findMetric = (output: string, labels: string[]): number => {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = output.match(new RegExp(`${escaped}\\s*:?\\s*([0-9][0-9,]*)`, 'i'));
    const value = parseNumber(match?.[1]);
    if (value > 0) {
      return value;
    }
  }

  return 0;
};

export const parseAntigravityContextUsage = (output: string): AntigravityContextUsage | null => {
  const used = findMetric(output, ['used tokens', 'tokens used', 'used']);
  const total = findMetric(output, ['total tokens', 'context window', 'total']);
  const freeSpace = findMetric(output, ['free space', 'remaining']);
  const checkpointBuffer = findMetric(output, ['checkpoint buffer']);
  const userMessages = findMetric(output, ['user messages', 'user']);
  const agentResponses = findMetric(output, ['agent responses', 'assistant responses', 'agent']);
  const toolCalls = findMetric(output, ['tool calls']);
  const systemPrompt = findMetric(output, ['system prompt']);
  const systemTools = findMetric(output, ['system tools']);
  const skills = findMetric(output, ['skills']);
  const subagents = findMetric(output, ['subagents']);

  const inferredUsed = used || userMessages + agentResponses + toolCalls + systemPrompt + systemTools + skills + subagents;
  const inferredTotal = total || inferredUsed + freeSpace;
  if (inferredUsed <= 0 && inferredTotal <= 0) {
    return null;
  }

  return {
    used: inferredUsed,
    total: inferredTotal,
    freeSpace: freeSpace || undefined,
    checkpointBuffer: checkpointBuffer || undefined,
    inputTokens: userMessages || undefined,
    outputTokens: agentResponses || undefined,
    breakdown: {
      input: userMessages,
      output: agentResponses,
      toolCalls: toolCalls || undefined,
      systemPrompt: systemPrompt || undefined,
      systemTools: systemTools || undefined,
      skills: skills || undefined,
      subagents: subagents || undefined,
    },
    source: 'antigravity_context',
  };
};

export const getAntigravityContextUsage = async (
  conversationId: string,
  workingDir: string,
): Promise<AntigravityContextUsage | null> => {
  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) {
    return null;
  }

  const resolvedWorkingDir = path.resolve(workingDir || process.cwd());
  const cacheKey = `${normalizedConversationId}:${resolvedWorkingDir}`;
  const cached = usageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.usage;
  }

  let output = '';
  try {
    output = await new Promise<string>((resolve) => {
      let terminalOutput = '';
      const agyPty = pty.spawn(getAntigravityExecutable(), [
        '--conversation',
        normalizedConversationId,
        '--add-dir',
        resolvedWorkingDir,
      ], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: resolvedWorkingDir,
        env: { ...process.env },
      });

      const stopPty = (): boolean => {
        try {
          agyPty.kill();
          return true;
        } catch {
          return false;
        }
      };

      const timer = setTimeout(() => {
        void stopPty();
        resolve(terminalOutput);
      }, CONTEXT_COMMAND_TIMEOUT_MS);

      agyPty.onData((data) => {
        terminalOutput += data;
        if (/context/i.test(terminalOutput) && /used|total|free space/i.test(terminalOutput)) {
          clearTimeout(timer);
          void stopPty();
          resolve(terminalOutput);
        }
      });

      agyPty.write('/context\r');
    });
  } catch {
    return null;
  }

  const usage = parseAntigravityContextUsage(output);
  if (usage) {
    usageCache.set(cacheKey, {
      usage,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  return usage;
};
