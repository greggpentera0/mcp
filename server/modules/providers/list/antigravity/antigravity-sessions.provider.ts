import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';
import {
  cleanAntigravityAssistantText,
  getAntigravityConversationFilePath,
  readAntigravityConversation,
} from '@/modules/providers/list/antigravity/antigravity-storage.js';

const PROVIDER = 'antigravity';

export class AntigravitySessionsProvider implements IProviderSessions {
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      if (typeof rawMessage !== 'string') {
        return [];
      }

      const content = cleanAntigravityAssistantText(rawMessage);
      return content
        ? [createNormalizedMessage({
            id: generateMessageId('antigravity'),
            sessionId,
            provider: PROVIDER,
            kind: 'stream_delta',
            content,
          })]
        : [];
    }

    const kind = readOptionalString(raw.kind) ?? readOptionalString(raw.type) ?? '';
    const eventSessionId = readOptionalString(raw.sessionId)
      ?? readOptionalString(raw.conversationId)
      ?? sessionId;
    const baseId = readOptionalString(raw.id) ?? generateMessageId('antigravity');

    if (kind === 'error') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(raw.error) ?? readOptionalString(raw.message) ?? 'Unknown Antigravity error',
      })];
    }

    if (kind === 'stream_end' || kind === 'complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    const content = cleanAntigravityAssistantText(
      readOptionalString(raw.content)
      ?? readOptionalString(raw.text)
      ?? readOptionalString(raw.delta)
      ?? '',
    );

    if (!content) {
      return [];
    }

    return [createNormalizedMessage({
      id: baseId,
      sessionId: eventSessionId,
      provider: PROVIDER,
      kind: 'stream_delta',
      content,
    })];
  }

  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const providerSessionId = options.providerSessionId ?? sessionId;
    const conversation = await readAntigravityConversation(
      getAntigravityConversationFilePath(providerSessionId),
    );

    if (!conversation) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const normalized = conversation.messages.map((message) => createNormalizedMessage({
      id: message.id,
      sessionId,
      timestamp: message.timestamp,
      provider: PROVIDER,
      kind: 'text',
      role: message.role,
      content: message.content,
    }));

    const normalizedOffset = Math.max(0, options.offset ?? 0);
    const normalizedLimit = options.limit === undefined ? null : options.limit;
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total: normalized.length,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
