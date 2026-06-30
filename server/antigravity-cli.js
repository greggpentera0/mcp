import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { getAntigravityExecutable } from './modules/providers/list/antigravity/antigravity-auth.provider.js';
import {
  cleanAntigravityAssistantText,
  getAntigravityConversationIdFromPath,
  isAntigravityConversationFile,
} from './modules/providers/list/antigravity/antigravity-storage.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  getAntigravityConversationsPath,
} from './shared/utils.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;
const activeAntigravityProcesses = new Map();

async function discoverNewestConversationId(startedAt) {
  try {
    const conversationsPath = getAntigravityConversationsPath();
    const entries = await fs.readdir(conversationsPath, { withFileTypes: true });
    const candidates = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(conversationsPath, entry.name);
      if (!isAntigravityConversationFile(filePath)) {
        continue;
      }

      const stats = await fs.stat(filePath);
      if (stats.mtimeMs + 2_000 < startedAt) {
        continue;
      }

      candidates.push({ filePath, mtimeMs: stats.mtimeMs });
    }

    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return candidates[0] ? getAntigravityConversationIdFromPath(candidates[0].filePath) : null;
  } catch {
    return null;
  }
}

async function spawnAntigravity(command, options = {}, ws) {
  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, permissionMode, sessionSummary } = options;
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    const startedAt = Date.now();
    let capturedSessionId = sessionId || null;
    let sessionCreatedSent = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let terminalNotificationSent = false;
    let antigravityProcess = null;
    let completeSent = false;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'antigravity',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'antigravity',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Antigravity CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      if (processKey !== capturedSessionId && antigravityProcess) {
        activeAntigravityProcesses.delete(processKey);
        activeAntigravityProcesses.set(capturedSessionId, antigravityProcess);
      }
      if (antigravityProcess) {
        antigravityProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!sessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'antigravity',
        }));
      }
    };

    const emitAssistantOutput = () => {
      const content = cleanAntigravityAssistantText(stdoutBuffer);
      if (!content) {
        return;
      }

      const normalized = sessionsService.normalizeMessage(
        'antigravity',
        content,
        capturedSessionId || sessionId || null,
      );
      for (const message of normalized) {
        ws.send(message);
      }
    };

    void providerModelsService.resolveResumeModel('antigravity', sessionId, model).then((resolvedModel) => {
      const args = [];
      if (sessionId) {
        args.push('--conversation', sessionId);
      }
      if (resolvedModel) {
        args.push('--model', resolvedModel);
      }
      args.push('--add-dir', workingDir);
      if (permissionMode === 'bypassPermissions') {
        args.push('--dangerously-skip-permissions');
      }
      args.push('--print', command.trim());

      antigravityProcess = spawnFunction(getAntigravityExecutable(), args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      activeAntigravityProcesses.set(processKey, antigravityProcess);
      antigravityProcess.sessionId = processKey;
      antigravityProcess.stdin.end();

      antigravityProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
      });

      antigravityProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
      });

      antigravityProcess.on('close', async (code) => {
        const discoveredSessionId = capturedSessionId || await discoverNewestConversationId(startedAt);
        if (discoveredSessionId) {
          registerSession(discoveredSessionId);
        }

        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeAntigravityProcesses.delete(finalSessionId);
        activeAntigravityProcesses.delete(processKey);

        emitAssistantOutput();
        ws.send(createNormalizedMessage({
          kind: 'stream_end',
          sessionId: finalSessionId,
          provider: 'antigravity',
        }));

        if (code !== 0 && stderrBuffer.trim()) {
          ws.send(createNormalizedMessage({
            kind: 'error',
            content: stderrBuffer.trim(),
            sessionId: finalSessionId,
            provider: 'antigravity',
          }));
        }

        if (!completeSent && !antigravityProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'antigravity', sessionId: finalSessionId, exitCode: code }));
        }

        if (code === 0) {
          notifyTerminalState({ code });
          resolve();
          return;
        }

        if (code === 127 || code === null) {
          const installed = await providerAuthService.isProviderInstalled('antigravity');
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: 'Antigravity CLI is not installed. Install and authenticate the agy CLI before using this provider.',
              sessionId: finalSessionId,
              provider: 'antigravity',
            }));
          }
        }

        notifyTerminalState({ code });
        reject(new Error(code === null ? 'Antigravity CLI process was terminated' : `Antigravity CLI exited with code ${code}`));
      });

      antigravityProcess.on('error', async (error) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeAntigravityProcesses.delete(finalSessionId);
        activeAntigravityProcesses.delete(processKey);

        const installed = await providerAuthService.isProviderInstalled('antigravity');
        const errorContent = !installed
          ? 'Antigravity CLI is not installed. Install and authenticate the agy CLI before using this provider.'
          : error.message;

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'antigravity',
        }));
        if (!completeSent && !antigravityProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'antigravity', sessionId: finalSessionId, exitCode: 1 }));
        }
        notifyTerminalState({ error });
        reject(error);
      });
    }).catch(reject);
  });
}

function abortAntigravitySession(sessionId) {
  const process = activeAntigravityProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  process.aborted = true;
  process.kill('SIGTERM');
  activeAntigravityProcesses.delete(sessionId);
  return true;
}

function isAntigravitySessionActive(sessionId) {
  return activeAntigravityProcesses.has(sessionId);
}

function getActiveAntigravitySessions() {
  return Array.from(activeAntigravityProcesses.keys());
}

export {
  spawnAntigravity,
  abortAntigravitySession,
  isAntigravitySessionActive,
  getActiveAntigravitySessions,
};
