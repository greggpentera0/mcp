import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  findFilesRecursivelyCreatedAfter,
  getAntigravityConversationsPath,
} from '@/shared/utils.js';
import {
  isAntigravityConversationFile,
  readAntigravityConversation,
} from '@/modules/providers/list/antigravity/antigravity-storage.js';

export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'antigravity' as const;

  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyCreatedAfter(
      getAntigravityConversationsPath(),
      '.db',
      since ?? null,
    );

    let processed = 0;
    for (const filePath of files) {
      const sessionId = await this.synchronizeFile(filePath);
      if (sessionId) {
        processed += 1;
      }
    }

    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!isAntigravityConversationFile(filePath)) {
      return null;
    }

    const conversation = await readAntigravityConversation(filePath);
    if (!conversation?.projectPath) {
      return null;
    }

    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(conversation.conversationId)
      ?? sessionsDb.getSessionById(conversation.conversationId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, conversation.projectPath);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, conversation.conversationId);
    }

    return sessionsDb.createSession(
      conversation.conversationId,
      this.provider,
      conversation.projectPath,
      conversation.sessionName,
      conversation.createdAt,
      conversation.updatedAt,
      conversation.filePath,
    );
  }
}
