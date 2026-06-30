import fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { AnyRecord } from '@/shared/types.js';
import {
  getAntigravityConversationsPath,
  getAntigravityHistoryPath,
  getAntigravitySettingsPath,
  normalizeProviderTimestamp,
  normalizeSessionName,
  readFileTimestamps,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

export type AntigravityConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
};

export type AntigravityConversationRecord = {
  conversationId: string;
  filePath: string;
  projectPath: string | null;
  sessionName: string;
  createdAt: string;
  updatedAt: string;
  messages: AntigravityConversationMessage[];
};

type AntigravityStepRow = {
  idx: number;
  step_type: string | null;
  metadata: string | null;
  step_payload: string | null;
};

const INTERNAL_TOOL_NAMES = new Set([
  'run_command',
  'manage_task',
  'manage_subagents',
  'read_file',
  'write_file',
  'replace_file',
  'list_directory',
  'search_file_content',
  'grep',
  'glob',
  'edit',
  'apply_patch',
  'web_fetch',
  'web_search',
]);

const TEXT_KEYS = [
  'text',
  'content',
  'message',
  'response',
  'answer',
  'delta',
  'summary',
  'prompt',
];

const PATH_KEYS = [
  'workspacePath',
  'workspace_path',
  'workingDirectory',
  'working_directory',
  'cwd',
  'projectPath',
  'project_path',
  'repoPath',
  'repositoryPath',
  'rootPath',
  'folder',
  'directory',
];

const JSON_FRAGMENT_PATTERN = /^\s*[\[{]/;
const BOT_MARKER_PATTERN = /(?:<\|.*?\|>|^assistant\s*:|^model\s*:)/i;
const UUID_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db$/i;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_./+=:-]{80,}$/;
const MAX_TEXT_FRAGMENT_LENGTH = 8_000;

export const isAntigravityConversationFile = (filePath: string): boolean =>
  path.extname(filePath) === '.db' && UUID_FILE_PATTERN.test(path.basename(filePath));

export const getAntigravityConversationIdFromPath = (filePath: string): string =>
  path.basename(filePath, '.db');

export const getAntigravityConversationFilePath = (conversationId: string): string =>
  path.join(getAntigravityConversationsPath(), `${conversationId}.db`);

const parseJsonMaybe = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (!JSON_FRAGMENT_PATTERN.test(trimmed) && !(trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
};

const normalizeTextKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .trim();

export const isLikelyInternalAntigravityText = (value: string): boolean => {
  const text = value.trim();
  if (!text) {
    return true;
  }

  if (text.length > MAX_TEXT_FRAGMENT_LENGTH) {
    return true;
  }

  if (JSON_FRAGMENT_PATTERN.test(text)) {
    return true;
  }

  if (OPAQUE_TOKEN_PATTERN.test(text)) {
    return true;
  }

  if (BOT_MARKER_PATTERN.test(text)) {
    return true;
  }

  const lower = text.toLowerCase();
  if ([...INTERNAL_TOOL_NAMES].some((name) => lower === name || lower.startsWith(`${name}:`))) {
    return true;
  }

  return false;
};

export const cleanAntigravityAssistantText = (value: string): string => {
  const lines = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !isLikelyInternalAntigravityText(line));

  const emitted = new Set<string>();
  const uniqueLines: string[] = [];
  for (const line of lines) {
    const key = normalizeTextKey(line);
    if (!key || emitted.has(key)) {
      continue;
    }

    emitted.add(key);
    uniqueLines.push(line);
  }

  return uniqueLines.join('\n').trim();
};

const isToolLikeRecord = (record: AnyRecord): boolean => {
  const type = readOptionalString(record.type)?.toLowerCase();
  const stepType = readOptionalString(record.step_type)?.toLowerCase();
  const name = (
    readOptionalString(record.name)
    ?? readOptionalString(record.tool_name)
    ?? readOptionalString(record.toolName)
    ?? readOptionalString(record.function_name)
  )?.toLowerCase();

  return Boolean(
    (type && (type.includes('tool') || type.includes('function_call')))
    || (stepType && stepType.includes('tool'))
    || (name && INTERNAL_TOOL_NAMES.has(name)),
  );
};

const inferRole = (stepType: unknown, value: unknown): 'user' | 'assistant' | null => {
  const record = readObjectRecord(value);
  const explicitRole = readOptionalString(record?.role)
    ?? readOptionalString(record?.author)
    ?? readOptionalString(record?.speaker);
  if (explicitRole === 'user') {
    return 'user';
  }
  if (explicitRole === 'assistant' || explicitRole === 'model' || explicitRole === 'agent') {
    return 'assistant';
  }

  const normalizedStepType = typeof stepType === 'string' ? stepType.toLowerCase() : '';
  if (normalizedStepType.includes('user')) {
    return 'user';
  }
  if (
    normalizedStepType.includes('assistant')
    || normalizedStepType.includes('agent')
    || normalizedStepType.includes('model')
    || normalizedStepType.includes('response')
  ) {
    return 'assistant';
  }

  return null;
};

const collectTextCandidates = (
  value: unknown,
  role: 'user' | 'assistant' | null,
  output: string[],
  depth = 0,
): void => {
  if (depth > 8 || value === null || value === undefined) {
    return;
  }

  const parsed = parseJsonMaybe(value);
  if (typeof parsed === 'string') {
    if (role && !isLikelyInternalAntigravityText(parsed)) {
      output.push(parsed.trim());
    }
    return;
  }

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      collectTextCandidates(entry, role, output, depth + 1);
    }
    return;
  }

  const record = readObjectRecord(parsed);
  if (!record || isToolLikeRecord(record)) {
    return;
  }

  const resolvedRole = inferRole(null, record) ?? role;
  for (const key of TEXT_KEYS) {
    if (record[key] === undefined) {
      continue;
    }
    collectTextCandidates(record[key], resolvedRole, output, depth + 1);
  }

  for (const key of ['parts', 'chunks', 'messages', 'items', 'candidates']) {
    if (record[key] !== undefined) {
      collectTextCandidates(record[key], resolvedRole, output, depth + 1);
    }
  }
};

const collectPathCandidates = (value: unknown, output: string[], depth = 0): void => {
  if (depth > 8 || value === null || value === undefined) {
    return;
  }

  const parsed = parseJsonMaybe(value);
  if (typeof parsed === 'string') {
    return;
  }

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      collectPathCandidates(entry, output, depth + 1);
    }
    return;
  }

  const record = readObjectRecord(parsed);
  if (!record) {
    return;
  }

  for (const key of PATH_KEYS) {
    const candidate = readOptionalString(record[key]);
    if (candidate && path.isAbsolute(candidate)) {
      output.push(candidate);
    }
  }

  for (const entry of Object.values(record)) {
    collectPathCandidates(entry, output, depth + 1);
  }
};

const readAntigravityHistoryEntry = async (conversationId: string): Promise<AnyRecord | null> => {
  try {
    const content = await readFile(getAntigravityHistoryPath(), 'utf8');
    for (const line of content.split(/\r?\n/).reverse()) {
      const record = readJsonRecord(line);
      if (!record) {
        continue;
      }

      const id = readOptionalString(record.conversationId)
        ?? readOptionalString(record.conversation_id)
        ?? readOptionalString(record.id);
      if (id === conversationId) {
        return record;
      }
    }
  } catch {
    return null;
  }

  return null;
};

const readTrustedSettingsRecord = async (): Promise<AnyRecord | null> => {
  try {
    return readJsonRecord(await readFile(getAntigravitySettingsPath(), 'utf8'));
  } catch {
    return null;
  }
};

const resolveProjectPath = async (
  conversationId: string,
  rows: AntigravityStepRow[],
): Promise<string | null> => {
  const candidates: string[] = [];
  for (const row of rows) {
    collectPathCandidates(row.metadata, candidates);
    collectPathCandidates(row.step_payload, candidates);
  }

  const historyEntry = await readAntigravityHistoryEntry(conversationId);
  collectPathCandidates(historyEntry, candidates);

  const settings = await readTrustedSettingsRecord();
  collectPathCandidates(settings, candidates);

  return candidates.find((candidate) => path.isAbsolute(candidate)) ?? null;
};

const readSteps = (db: Database.Database): AntigravityStepRow[] => {
  const columns = db.prepare('PRAGMA table_info(steps)').all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['idx', 'step_type', 'metadata', 'step_payload'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return [];
  }

  return db.prepare(`
    SELECT idx, step_type, metadata, step_payload
    FROM steps
    ORDER BY idx ASC
  `).all() as AntigravityStepRow[];
};

const buildMessages = (
  rows: AntigravityStepRow[],
  fallbackTimestamp: string,
): AntigravityConversationMessage[] => {
  const messages: AntigravityConversationMessage[] = [];
  const emittedAssistantText = new Set<string>();

  for (const row of rows) {
    const metadata = parseJsonMaybe(row.metadata);
    const payload = parseJsonMaybe(row.step_payload);
    const role = inferRole(row.step_type, metadata) ?? inferRole(row.step_type, payload);
    if (!role) {
      continue;
    }

    const candidates: string[] = [];
    collectTextCandidates(payload, role, candidates);
    if (candidates.length === 0) {
      collectTextCandidates(metadata, role, candidates);
    }

    const content = role === 'assistant'
      ? cleanAntigravityAssistantText(candidates.join('\n'))
      : candidates.join('\n').trim();
    if (!content) {
      continue;
    }

    const normalizedKey = normalizeTextKey(content);
    if (role === 'assistant') {
      if (emittedAssistantText.has(normalizedKey)) {
        continue;
      }
      emittedAssistantText.add(normalizedKey);
    }

    const timestamp = normalizeProviderTimestamp(
      readObjectRecord(metadata)?.timestamp
      ?? readObjectRecord(metadata)?.time
      ?? fallbackTimestamp,
    );
    messages.push({
      id: `antigravity_${row.idx}_${role}`,
      role,
      content,
      timestamp,
    });
  }

  return messages;
};

export const readAntigravityConversation = async (
  filePath: string,
): Promise<AntigravityConversationRecord | null> => {
  if (!isAntigravityConversationFile(filePath) || !fsSync.existsSync(filePath)) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const rows = readSteps(db);
    const timestamps = await readFileTimestamps(filePath);
    const fallbackTimestamp = new Date().toISOString();
    const updatedAt = timestamps.updatedAt ?? timestamps.createdAt ?? fallbackTimestamp;
    const createdAt = timestamps.createdAt ?? updatedAt;
    const conversationId = getAntigravityConversationIdFromPath(filePath);
    const projectPath = await resolveProjectPath(conversationId, rows);
    const messages = buildMessages(rows, updatedAt);
    const firstUserMessage = messages.find((message) => message.role === 'user')?.content;

    return {
      conversationId,
      filePath,
      projectPath,
      sessionName: normalizeSessionName(firstUserMessage, 'New Antigravity Chat'),
      createdAt,
      updatedAt,
      messages,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[AntigravityProvider] Failed to read conversation DB:', { filePath, error: message });
    return null;
  } finally {
    db?.close();
  }
};
