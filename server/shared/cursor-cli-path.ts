import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CURSOR_AGENT_COMMAND = 'cursor-agent';
const CURSOR_AGENT_ENV_KEYS = ['CURSOR_AGENT_PATH', 'CURSOR_CLI_PATH'] as const;

export type ResolveCursorAgentExecutablePathDependencies = {
  accessSync?: typeof fs.accessSync;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
  homedir?: typeof os.homedir;
  platform?: NodeJS.Platform;
};

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function readCaseInsensitiveEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
}

function readConfiguredCursorAgentPath(env: NodeJS.ProcessEnv): string {
  for (const key of CURSOR_AGENT_ENV_KEYS) {
    const value = readCaseInsensitiveEnv(env, key);
    if (value?.trim()) {
      return value;
    }
  }

  return '';
}

function getPathEnvValue(env: NodeJS.ProcessEnv): string {
  return readCaseInsensitiveEnv(env, 'PATH') || '';
}

function isExecutableCandidate(
  candidate: string,
  deps: Required<ResolveCursorAgentExecutablePathDependencies>,
): boolean {
  try {
    if (deps.platform === 'win32') {
      return deps.existsSync(candidate);
    }

    deps.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(
  command: string,
  deps: Required<ResolveCursorAgentExecutablePathDependencies>,
): string | null {
  const pathEnv = getPathEnvValue(deps.env);
  if (!pathEnv) {
    return null;
  }

  const pathApi = deps.platform === 'win32' ? path.win32 : path;
  const delimiter = deps.platform === 'win32' ? path.win32.delimiter : path.posix.delimiter;
  const pathEntries = pathEnv.split(delimiter).map(stripWrappingQuotes).filter(Boolean);
  const candidateNames = deps.platform === 'win32'
    ? getWindowsCandidateNames(command, deps.env)
    : [command];

  for (const entry of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidate = pathApi.join(entry, candidateName);
      if (isExecutableCandidate(candidate, deps)) {
        return candidate;
      }
    }
  }

  return null;
}

function getWindowsCandidateNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (path.win32.extname(command)) {
    return [command];
  }

  const extensions = (readCaseInsensitiveEnv(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);

  return [
    command,
    ...extensions.map((extension) => `${command}${extension.toLowerCase()}`),
    ...extensions.map((extension) => `${command}${extension.toUpperCase()}`),
  ];
}

function resolveFromStandardLocations(
  deps: Required<ResolveCursorAgentExecutablePathDependencies>,
): string | null {
  if (deps.platform === 'win32') {
    return null;
  }

  const candidates = [
    path.join(deps.homedir(), '.local', 'bin', DEFAULT_CURSOR_AGENT_COMMAND),
    path.join('/opt', 'homebrew', 'bin', DEFAULT_CURSOR_AGENT_COMMAND),
    path.join('/usr', 'local', 'bin', DEFAULT_CURSOR_AGENT_COMMAND),
  ];

  for (const candidate of candidates) {
    if (isExecutableCandidate(candidate, deps)) {
      return candidate;
    }
  }

  return null;
}

export function resolveCursorAgentExecutablePath(
  configuredPath?: string,
  dependencies: ResolveCursorAgentExecutablePathDependencies = {},
): string {
  const deps: Required<ResolveCursorAgentExecutablePathDependencies> = {
    accessSync: dependencies.accessSync ?? fs.accessSync,
    env: dependencies.env ?? process.env,
    existsSync: dependencies.existsSync ?? fs.existsSync,
    homedir: dependencies.homedir ?? os.homedir,
    platform: dependencies.platform ?? process.platform,
  };
  const normalizedConfiguredPath = stripWrappingQuotes(
    configuredPath ?? readConfiguredCursorAgentPath(deps.env),
  );

  if (normalizedConfiguredPath) {
    return normalizedConfiguredPath;
  }

  return resolveFromPath(DEFAULT_CURSOR_AGENT_COMMAND, deps)
    ?? resolveFromStandardLocations(deps)
    ?? DEFAULT_CURSOR_AGENT_COMMAND;
}

export function buildCursorAgentNotFoundMessage(command: string): string {
  return [
    'Cursor CLI executable was not found.',
    'Install Cursor CLI or set CURSOR_AGENT_PATH to the cursor-agent executable.',
    `The server tried: ${command}.`,
  ].join(' ');
}
