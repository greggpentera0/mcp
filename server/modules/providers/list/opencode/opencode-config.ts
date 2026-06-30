import fs from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

const DEFAULT_OPENCODE_COMMAND = 'opencode';
const OPENCODE_EXECUTABLE_ENV_KEYS = ['OPENCODE_PATH', 'OPENCODE_CLI_PATH'] as const;
const LOCAL_OLLAMA_TAGS_TIMEOUT_MS = 2_000;
const LOCAL_OLLAMA_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export type OpenCodeConfigModels = {
  filePath: string;
  defaultModel: string | null;
  models: ProviderModelOption[];
};

export type ResolveOpenCodeExecutableDependencies = {
  accessSync?: typeof fs.accessSync;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
  homedir?: typeof os.homedir;
  platform?: NodeJS.Platform;
};

type OpenCodeConfigModelsFetchResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type OpenCodeConfigModelsFetch = (
  input: string | URL,
  init?: { signal?: AbortSignal },
) => Promise<OpenCodeConfigModelsFetchResponse>;

export type ReadOpenCodeConfigModelsOptions = {
  fetch?: OpenCodeConfigModelsFetch;
  timeoutMs?: number;
  validateLocalModels?: boolean;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const stripJsonComments = (content: string): string => {
  let output = '';
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
};

const stripTrailingCommas = (content: string): string =>
  content.replace(/,\s*([}\]])/g, '$1');

const stripWrappingQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

const readCaseInsensitiveEnv = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
};

const readConfiguredOpenCodePath = (env: NodeJS.ProcessEnv): string => {
  for (const key of OPENCODE_EXECUTABLE_ENV_KEYS) {
    const value = readCaseInsensitiveEnv(env, key);
    if (value?.trim()) {
      return value;
    }
  }

  return '';
};

const isExecutableCandidate = (
  candidate: string,
  deps: Required<ResolveOpenCodeExecutableDependencies>,
): boolean => {
  try {
    if (deps.platform === 'win32') {
      return deps.existsSync(candidate);
    }

    deps.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveStandardOpenCodeExecutable = (
  deps: Required<ResolveOpenCodeExecutableDependencies>,
): string | null => {
  if (deps.platform === 'win32') {
    return null;
  }

  const candidates = [
    path.join(deps.homedir(), '.local', 'bin', DEFAULT_OPENCODE_COMMAND),
    path.join(path.sep, 'opt', 'homebrew', 'bin', DEFAULT_OPENCODE_COMMAND),
    path.join(path.sep, 'usr', 'local', 'bin', DEFAULT_OPENCODE_COMMAND),
  ];

  for (const candidate of candidates) {
    if (isExecutableCandidate(candidate, deps)) {
      return candidate;
    }
  }

  return null;
};

export const getOpenCodeExecutable = (
  dependencies: ResolveOpenCodeExecutableDependencies = {},
): string => {
  const deps: Required<ResolveOpenCodeExecutableDependencies> = {
    accessSync: dependencies.accessSync ?? fs.accessSync,
    env: dependencies.env ?? process.env,
    existsSync: dependencies.existsSync ?? fs.existsSync,
    homedir: dependencies.homedir ?? os.homedir,
    platform: dependencies.platform ?? process.platform,
  };
  const configuredPath = stripWrappingQuotes(readConfiguredOpenCodePath(deps.env));
  if (configuredPath) {
    return configuredPath;
  }

  return resolveStandardOpenCodeExecutable(deps) ?? DEFAULT_OPENCODE_COMMAND;
};

export const buildOpenCodeNotFoundMessage = (command: string): string => [
  'OpenCode CLI executable was not found.',
  'Install OpenCode or set OPENCODE_PATH to the opencode executable.',
  `The server tried: ${command}.`,
].join(' ');

export const resolveOpenCodeConfigCandidates = (): string[] => [
  process.env.OPENCODE_CONFIG?.trim() || '',
  path.join(os.homedir(), 'opencode.json'),
  path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
  path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
].filter(Boolean);

export const resolveExistingOpenCodeConfigPath = async (): Promise<string | null> => {
  for (const filePath of resolveOpenCodeConfigCandidates()) {
    if (await fileExists(filePath)) {
      return filePath;
    }
  }

  return null;
};

export const readOpenCodeConfigFile = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(content))) as unknown;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

export const writeOpenCodeConfigFile = async (
  filePath: string,
  data: Record<string, unknown>,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const normalizeConfigModelId = (providerId: string, modelId: string): string => {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return '';
  }

  return normalizedModelId.includes('/')
    ? normalizedModelId
    : `${providerId}/${normalizedModelId}`;
};

const readProviderBaseURL = (providerConfig: Record<string, unknown> | undefined): string | null => {
  const providerOptions = readObjectRecord(providerConfig?.options);
  return readOptionalString(providerOptions?.baseURL)
    ?? readOptionalString(providerConfig?.baseURL)
    ?? null;
};

const joinUrlPath = (basePath: string, suffixPath: string): string => {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  const normalizedSuffix = suffixPath.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedSuffix}`;
};

const resolveLocalOllamaTagsURL = (
  providerId: string,
  providerConfig: Record<string, unknown>,
): string | null => {
  if (providerId !== 'ollama') {
    return null;
  }

  const rawBaseURL = readProviderBaseURL(providerConfig) ?? 'http://127.0.0.1:11434/v1';

  try {
    const url = new URL(rawBaseURL);
    if (!LOCAL_OLLAMA_HOSTNAMES.has(url.hostname)) {
      return null;
    }

    const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/, '');
    const apiRootPath = pathWithoutTrailingSlash.endsWith('/v1')
      ? pathWithoutTrailingSlash.slice(0, -3) || '/'
      : pathWithoutTrailingSlash || '/';

    url.pathname = joinUrlPath(apiRootPath, 'api/tags');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

const parseOllamaModelNames = (payload: unknown): Set<string> | null => {
  const record = readObjectRecord(payload);
  const models = record && Array.isArray(record.models) ? record.models : null;
  if (!models) {
    return null;
  }

  const names = models
    .map((model) => {
      const modelRecord = readObjectRecord(model);
      return readOptionalString(modelRecord?.name) ?? readOptionalString(modelRecord?.model);
    })
    .filter((name): name is string => Boolean(name?.trim()));

  return new Set(names);
};

const readLocalOllamaModelNames = async (
  tagsURL: string,
  options: ReadOpenCodeConfigModelsOptions,
): Promise<Set<string> | null> => {
  const fetchModelTags = options.fetch ?? (globalThis.fetch as OpenCodeConfigModelsFetch | undefined);
  if (!fetchModelTags) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? LOCAL_OLLAMA_TAGS_TIMEOUT_MS,
  );

  try {
    const response = await fetchModelTags(tagsURL, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }

    return parseOllamaModelNames(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

export const readOpenCodeConfigModels = async (
  readOptions: ReadOpenCodeConfigModelsOptions = {},
): Promise<OpenCodeConfigModels | null> => {
  const filePath = await resolveExistingOpenCodeConfigPath();
  if (!filePath) {
    return null;
  }

  const config = await readOpenCodeConfigFile(filePath);
  const providers = readObjectRecord(config.provider) ?? {};
  const modelOptions: ProviderModelOption[] = [];

  for (const [providerId, rawProviderConfig] of Object.entries(providers)) {
    const providerConfig = readObjectRecord(rawProviderConfig);
    if (!providerConfig) {
      continue;
    }

    const models = readObjectRecord(providerConfig.models);
    if (!models) {
      continue;
    }

    const providerName = readOptionalString(providerConfig?.name) ?? providerId;
    const localTagsURL = readOptions.validateLocalModels
      ? resolveLocalOllamaTagsURL(providerId, providerConfig)
      : null;
    const localModelNames = localTagsURL
      ? await readLocalOllamaModelNames(localTagsURL, readOptions)
      : null;

    for (const [rawModelId, rawModelConfig] of Object.entries(models)) {
      const value = normalizeConfigModelId(providerId, rawModelId);
      if (!value) {
        continue;
      }

      const normalizedModelId = rawModelId.trim();
      if (
        localModelNames
        && !localModelNames.has(normalizedModelId)
        && !localModelNames.has(value)
      ) {
        continue;
      }

      const modelConfig = readObjectRecord(rawModelConfig);
      const label = readOptionalString(modelConfig?.name) ?? rawModelId;
      modelOptions.push({
        value,
        label,
        description: `${providerName} - ${value}`,
      });
    }
  }

  return {
    filePath,
    defaultModel: readOptionalString(config.model) ?? null,
    models: modelOptions,
  };
};

export const buildOpenCodeConfigModelsDefinition = (
  configModels: OpenCodeConfigModels,
  fallback: ProviderModelsDefinition,
): ProviderModelsDefinition => {
  if (configModels.models.length === 0) {
    return fallback;
  }

  const defaultModel = configModels.defaultModel;
  return {
    OPTIONS: configModels.models,
    DEFAULT: defaultModel && configModels.models.some((option) => option.value === defaultModel)
      ? defaultModel
      : configModels.models[0].value,
  };
};
