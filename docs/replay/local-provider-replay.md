# MCP Playground Local Provider Replay Instructions

## Table Of Contents

1. Scope
2. Local Runtime Contract
3. Replay Order
4. Local Environment
5. Provider Inventory
6. Antigravity Provider
7. Antigravity Sessions And Token Usage
8. OpenCode Local Config And Ollama
9. Provider Registry, Routes, And Capabilities
10. Chat Runtime Wiring
11. Settings And Onboarding UI
12. Model Picker
13. Slash Command Selector
14. Documentation And Assets
15. Files To Touch
16. Validation Checks
17. Replay Cautions

## Scope

This document is a repeatable checklist for replaying the provider and UI changes added after the base MCP Playground fork work in `instructions.md`.

The end state is a local-first MCP Playground app that runs with the original host-machine workflow:

- `npm run dev` for local development.
- `npm run build && npm run server` for the production backend bundle.
- Host-installed CLIs are executed directly by the Node server and shell sessions.
- CLI home directories, auth files, databases, and settings are read from the current OS user account.

Do not replay the alternate packaged runtime or host-CLI bridge work for this version. The agent CLIs and MCP services depend on OS-local paths, local sockets, local auth stores, and platform-specific binaries. Keep execution on the host machine.

The work covered here:

- Add `antigravity` as a first-class provider backed by `agy`.
- Index `agy` sessions from `~/.gemini/antigravity-cli/`.
- Support Antigravity MCP servers, skills, permissions, models, auth status, shell login, and token context usage.
- Improve Antigravity live output cleanup so repeated text, tool echoes, and session fragments do not render as chat responses.
- Make OpenCode work from the local `~/opencode.json` config, including Ollama-backed model IDs.
- Treat an OpenCode config with configured models as a usable local authentication state.
- Add OpenCode and Antigravity to settings, onboarding, MCP, provider logos, chat labels, and model selection.
- Collapse the model picker by parent provider by default.
- Render the slash command selector as a fixed portal so it is not clipped by the composer.

## Local Runtime Contract

Run MCP Playground directly on the machine where the provider CLIs are installed.

Required local tools:

```bash
node --version
npm --version
claude --version
codex --version
gemini --version
agy --version
opencode --version
```

Only the CLIs you plan to use must be installed and authenticated. Missing providers should show a clear installation or authentication message without breaking the rest of the app.

Local run commands:

```bash
cp .env.example .env
npm install
npm run dev
```

Development URLs:

```text
Frontend: http://localhost:5173
Backend:  http://localhost:3221
Health:   http://localhost:3221/health
```

Production local run:

```bash
npm run build
npm run server
```

## Replay Order

Apply changes in this order:

1. Start from a branch that already contains the base MCP Playground work from `instructions.md`.
2. Remove non-local run assumptions from the replay plan and docs.
3. Add the `antigravity` provider backend modules.
4. Wire `antigravity` into the shared provider registry, routes, services, session watcher, and CLI runtime.
5. Add Antigravity session parsing and context token usage.
6. Add OpenCode config parsing and model catalog support.
7. Wire `opencode` and `antigravity` through frontend provider state, settings, onboarding, MCP, skills, and logos.
8. Update chat runtime model selection, command handling, token usage, and session labels.
9. Update the model picker to collapse providers by default.
10. Update the slash command selector to render as a fixed portal.
11. Add focused tests for provider routing, OpenCode models/config, Antigravity sessions, MCP support, and model services.
12. Run local validation.

## Local Environment

Use local env vars that are read by the Node process directly:

```bash
SERVER_PORT=3221
VITE_PORT=5173

# Optional local-only auth bypass. Use only on a trusted local machine or behind
# external access control.
DISABLE_AUTH=true
VITE_DISABLE_AUTH=true

# Optional CLI path overrides. Leave as command names when the binaries are on PATH.
ANTIGRAVITY_PATH=agy
OPENCODE_PATH=opencode

# Optional OpenCode config path. If omitted, the app checks ~/opencode.json,
# ~/.config/opencode/opencode.json, and ~/.config/opencode/opencode.jsonc.
OPENCODE_CONFIG=/Users/<user>/opencode.json
```

Do not use `MCP_HOST_CLI_MODE`, `MCP_HOST_CLI_SSH_TARGET`, `MCP_HOST_CLI_BIN`, `MCP_ENABLE_HOST_OLLAMA_PROXY`, or any other bridge/proxy settings in this local replay.

For local OpenCode with Ollama, keep the OpenCode config pointed at host-local Ollama:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen3-coder:latest",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      },
      "models": {
        "qwen3-coder:latest": {
          "name": "Qwen 3 Coder (Local)"
        },
        "qwen2.5-coder:14b": {
          "name": "Qwen 2.5 Coder 14B (Local)"
        },
        "gemma4:latest": {
          "name": "Gemma 4 (Local)"
        }
      }
    }
  }
}
```

Verify Ollama before testing OpenCode:

```bash
ollama list
opencode models
opencode run --format json "Reply with OK."
```

## Provider Inventory

Extend the provider union everywhere provider IDs are enumerated:

```text
claude
cursor
codex
gemini
antigravity
opencode
```

Update both backend and frontend provider types:

- `server/shared/types.ts`
- `src/types/app.ts`

Use `antigravity` as the provider ID, not `agy`. Use `agy` only as the executable name.

## Antigravity Provider

Add a provider folder:

```text
server/modules/providers/list/antigravity/
```

Required modules:

- `antigravity.provider.ts`
- `antigravity-auth.provider.ts`
- `antigravity-models.provider.ts`
- `antigravity-sessions.provider.ts`
- `antigravity-session-synchronizer.provider.ts`
- `antigravity-storage.ts`
- `antigravity-context-usage.ts`
- `antigravity-mcp.provider.ts`
- `antigravity-skills.provider.ts`

Provider class:

- Extend `AbstractProvider`.
- Use provider ID `antigravity`.
- Expose `models`, `mcp`, `auth`, `skills`, `sessions`, and `sessionSynchronizer`.

Authentication:

- Check installation with `agy --version`.
- Check authentication with `agy models`.
- Return `ProviderAuthStatus` with `provider: 'antigravity'`.
- Read the executable from `process.env.ANTIGRAVITY_PATH?.trim() || 'agy'`.
- Use clear errors when the CLI is missing or unauthenticated.

Models:

- Read selectable models from `agy models`.
- Fall back to known labels:
  - `Gemini 3.5 Flash (Medium)`
  - `Gemini 3.5 Flash (High)`
  - `Gemini 3.5 Flash (Low)`
  - `Gemini 3.1 Pro (High)`
  - `Gemini 3.1 Pro (Low)`
- Default to `Gemini 3.5 Flash (Medium)`.
- Persist per-session model overrides through the shared provider model-change utility.

MCP:

- Support scopes `user` and `project`.
- Support transports `stdio`, `http`, and `sse`.
- User settings path: `~/.gemini/antigravity-cli/settings.json`.
- Project settings path: `<workspace>/.gemini/antigravity-cli/settings.json`.
- Store MCP servers under `mcpServers`.

Skills:

- Scan these roots:
  - `~/.gemini/antigravity-cli/skills`
  - `~/.gemini/skills`
  - `<workspace>/.gemini/antigravity-cli/skills`
  - `<workspace>/.gemini/skills`
- Use `/` as the command prefix.

## Antigravity Sessions And Token Usage

Antigravity data paths:

```text
~/.gemini/antigravity-cli/conversations/
~/.gemini/antigravity-cli/history.jsonl
~/.gemini/antigravity-cli/settings.json
```

Add utility functions in `server/shared/utils.ts`:

- `getAntigravityDataRoot()`
- `getAntigravityConversationsPath()`
- `getAntigravityHistoryPath()`
- `getAntigravitySettingsPath()`

Session storage:

- Conversation files are SQLite `.db` files under `conversations/`.
- Conversation IDs are UUID file names.
- Read from the `steps` table with columns `idx`, `step_type`, `metadata`, and `step_payload`.
- Open databases as read-only with query-only pragmas.
- Extract:
  - conversation ID from file name
  - workspace path from step metadata/payload, history, or trusted settings
  - session name from first user text or history display
  - safe message text from step payloads

History cleanup:

- Filter internal tool names such as `run_command`, `manage_task`, `manage_subagents`, `read_file`, `write_file`, and similar tool echoes.
- Filter long session fragments and bot marker fragments.
- Remove duplicate assistant text by normalized content key.
- Ignore raw JSON object/array fragments and opaque tokens.
- Emit normalized `stream_delta`, `stream_end`, and `error` messages.

Session sync:

- Add Antigravity to the session synchronizer count map.
- Add Antigravity to `sessions-watcher.service.ts`.
- Watch `~/.gemini/antigravity-cli/conversations`.
- Only process `.db` files.
- On initial sync, scan all conversation DBs and rely on DB upserts for idempotency.

Live CLI runner:

- Add `server/antigravity-cli.js`.
- Spawn `agy` directly from the host OS.
- Build args:
  - `--conversation <sessionId>` when resuming
  - `--model <model>` when a model is selected
  - `--add-dir <workingDir>`
  - `--dangerously-skip-permissions` for bypass permission mode
  - `--print <prompt>`
- Discover a new conversation ID after the process exits by scanning for the newest matching conversation DB.
- Send `session_created` when a new native conversation ID is discovered.
- Emit cleaned assistant output as `stream_delta` followed by `stream_end`.
- Emit `complete` once per run.
- Track active Antigravity processes for abort support.

Context usage:

- Add `antigravity-context-usage.ts`.
- Spawn an interactive PTY with `agy --conversation <id> --add-dir <workspace>`.
- Type `/context`, select the context usage entry, and parse the terminal output.
- Parse:
  - used tokens
  - total tokens
  - free space
  - checkpoint buffer
  - user messages
  - agent responses
  - tool calls
  - system prompt
  - system tools
  - skills
  - subagents
- Cache context usage briefly by conversation ID and working directory.
- Surface the parsed value from the token usage endpoint as `contextUsage.source = 'antigravity_context'`.

## OpenCode Local Config And Ollama

Add:

```text
server/modules/providers/list/opencode/opencode-config.ts
```

Config lookup order:

1. `process.env.OPENCODE_CONFIG`
2. `~/opencode.json`
3. `~/.config/opencode/opencode.json`
4. `~/.config/opencode/opencode.jsonc`

Parser requirements:

- Accept JSON with line comments, block comments, and trailing commas.
- Read `model` as the preferred default.
- Read `provider.<providerId>.models`.
- Normalize model IDs so `qwen3-coder:latest` under provider `ollama` becomes `ollama/qwen3-coder:latest`.
- Preserve model labels from `models.<id>.name`.
- Preserve provider display names from `provider.<id>.name`.

Auth status:

- Keep checking `~/.local/share/opencode/auth.json`.
- Keep checking environment credential keys such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and related keys.
- Also treat a readable OpenCode config with configured models as authenticated.
- Return method `config_file` for config-backed local use.

Models:

- Merge config models before CLI models from `opencode models`.
- Prefer the config `model` field as default when it exists in the merged model set.
- Fall back to built-in OpenCode model options when neither config nor CLI models are available.
- Mark OpenCode model catalogs uncached so config changes show up without stale model lists.

Session token usage:

- Read OpenCode tokens from `~/.local/share/opencode/opencode.db`.
- If token columns do not exist in the local schema, return an unsupported token usage payload instead of an error.
- Include cache read/write tokens in input or total usage where available.

## Provider Registry, Routes, And Capabilities

Backend files to update:

- `server/modules/providers/provider.registry.ts`
- `server/modules/providers/provider.routes.ts`
- `server/modules/providers/services/provider-capabilities.service.ts`
- `server/modules/providers/services/provider-models.service.ts`
- `server/modules/providers/services/session-synchronizer.service.ts`
- `server/modules/providers/services/sessions-watcher.service.ts`
- `server/routes/agent.js`
- `server/routes/commands.js`
- `server/index.js`

Registry:

- Import `AntigravityProvider`.
- Add `antigravity: new AntigravityProvider()`.
- Ensure duplicate hardcoded provider allow-lists are replaced by the shared registry where possible.

Capabilities:

- Antigravity supports:
  - permission modes: `default`, `bypassPermissions`
  - abort: true
  - token usage: true
  - images: false unless verified otherwise
  - permission requests: false unless the CLI adds structured support later
- OpenCode supports:
  - permission modes: `default`
  - token usage: true when DB schema supports it
  - abort: true

Routes:

- Add provider path support for `antigravity`.
- Ensure unsupported provider errors come from the shared registry instead of a stale local list.
- Keep session ID validation strict with a bounded safe pattern.
- Add provider route regression tests so `antigravity` is accepted anywhere other registered providers are accepted.

Commands:

- Add `antigravity` and `opencode` to `/model` provider choices.
- Add human-readable provider names for command results.

## Chat Runtime Wiring

Backend WebSocket runtime:

- Add `spawnAntigravity` and `abortAntigravitySession` to `server/index.js`.
- Keep `spawnOpenCode` and `abortOpenCodeSession` wired for OpenCode.
- In shell command resolution:
  - Antigravity starts with `agy`.
  - Antigravity resume uses `agy --conversation "<id>"`.
  - OpenCode starts with `opencode`.
  - OpenCode resume uses `opencode --session "<id>"`.

Frontend chat state:

- Add `antigravityModel` and `opencodeModel`.
- Persist selected models in localStorage:
  - `antigravity-model`
  - `opencode-model`
- Load model catalogs for all providers:
  - `claude`
  - `cursor`
  - `codex`
  - `gemini`
  - `antigravity`
  - `opencode`
- Use backend capability data as the source of truth for permission modes.
- Keep frontend fallback capability maps for first paint and failed capability requests.

Chat composer:

- Include `antigravityModel` and `opencodeModel` when submitting prompts.
- For Antigravity and OpenCode settings commands, route users to the corresponding settings tab.
- Ensure provider labels render as `Antigravity` and `OpenCode`.

Messages:

- Show provider names and logos for Antigravity and OpenCode.
- Render cleaned Antigravity assistant output as normal markdown.
- Avoid rendering internal tool echo lines as meaningful assistant messages.

Token summary:

- Display Antigravity `/context` usage when present.
- Show `N/A` only when the provider explicitly returns `unsupported: true`.
- Keep the token summary button accessible with a meaningful `aria-label` and title.

## Settings And Onboarding UI

Provider lists:

- Add `antigravity` and `opencode` to agent provider arrays.
- Update initial provider auth status maps.
- Add provider auth status endpoints:
  - `/api/providers/antigravity/auth/status`
  - `/api/providers/opencode/auth/status`

Login modal:

- Antigravity login command: `agy`.
- OpenCode login command: `opencode auth login`.
- Keep the modal open after process exit so terminal output remains readable.

Settings tabs:

- Show Antigravity and OpenCode in `Agents`.
- Show account status, permission controls, MCP server configuration, and skill sections according to provider capability.
- For Antigravity permissions, expose the bypass mode as running `agy` with `--dangerously-skip-permissions`.
- For OpenCode, hide unsupported managed skill creation if the provider cannot safely write those files.

MCP UI:

- Add provider display names, scopes, transports, button classes, and working-directory support:
  - Antigravity: scopes `user`, `project`; transports `stdio`, `http`, `sse`; working directory supported.
  - OpenCode: scopes `user`, `project`; transports `stdio`, `http`; working directory not required.

Onboarding:

- Add provider cards for Antigravity and OpenCode with their auth status.
- Keep local CLI setup instructions factual and avoid provider-specific claims that are not implemented.

## Model Picker

File:

```text
src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx
```

Required behavior:

- Display models grouped by parent provider.
- Keep all provider groups collapsed by default when the dialog opens.
- Allow each provider header to expand or collapse.
- Show provider icon, provider name, current selected model label, and model count in each header.
- Expand all matching groups while the user is searching.
- Show the empty search state only while a search query is active.
- Selecting a model should:
  - set the active provider
  - persist `selected-provider`
  - persist the provider-specific model key
  - close the dialog
  - return focus to the chat textarea

## Slash Command Selector

Files:

```text
src/components/chat/view/subcomponents/ChatComposer.tsx
src/components/chat/view/subcomponents/CommandMenu.tsx
```

Problem to solve:

- The command selector can be clipped by the composer/transcript layout when rendered inline.
- The command trigger tooltip can remain visible over the selector.

Required behavior:

- `ChatComposer` measures the composer anchor using `getBoundingClientRect()`.
- Recompute selector position while open on:
  - open state changes
  - window resize
  - window scroll
  - composer resize through `ResizeObserver`
- `CommandMenu` renders with `createPortal(..., document.body)`.
- Position the menu with `position: fixed`.
- Anchor the menu above the composer with an 8 px gap.
- Clamp top, left, width, and max height to the viewport.
- Use a mobile layout with left/right viewport margins.
- Hide the command trigger tooltip while the selector is open.
- Stop the trigger `mousedown` from bubbling into the document outside-click handler.

Acceptance checks:

- Clicking the command button opens a full selector above the composer.
- Typing `/` opens the same selector.
- The selector is not clipped by the input box or message pane.
- The tooltip `Show all commands` is not visible while the selector is open.
- Escape closes the selector.

## Documentation And Assets

Keep the base branding and asset instructions from `instructions.md`.

For this replay:

- Update README local run instructions as needed for Antigravity and OpenCode.
- Keep the app documented as local host execution through `npm run dev`, PM2, or `npm run server`.
- Remove non-local run instructions from the replay output.
- Do not add generated dependency folders or committed local auth/config files.

Do not commit:

- `.env`
- `node_modules`
- provider auth files
- provider conversation databases
- local OpenCode config files
- local Ollama data

## Files To Touch

Backend new files:

```text
server/antigravity-cli.js
server/modules/providers/list/antigravity/antigravity.provider.ts
server/modules/providers/list/antigravity/antigravity-auth.provider.ts
server/modules/providers/list/antigravity/antigravity-context-usage.ts
server/modules/providers/list/antigravity/antigravity-mcp.provider.ts
server/modules/providers/list/antigravity/antigravity-models.provider.ts
server/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.ts
server/modules/providers/list/antigravity/antigravity-sessions.provider.ts
server/modules/providers/list/antigravity/antigravity-skills.provider.ts
server/modules/providers/list/antigravity/antigravity-storage.ts
server/modules/providers/list/opencode/opencode-config.ts
server/modules/providers/tests/antigravity-sessions.test.ts
server/modules/providers/tests/provider-routes.test.ts
```

Backend existing files:

```text
server/index.js
server/opencode-cli.js
server/routes/agent.js
server/routes/commands.js
server/shared/types.ts
server/shared/utils.ts
server/modules/providers/provider.registry.ts
server/modules/providers/provider.routes.ts
server/modules/providers/services/provider-capabilities.service.ts
server/modules/providers/services/provider-models.service.ts
server/modules/providers/services/session-synchronizer.service.ts
server/modules/providers/services/sessions-watcher.service.ts
server/modules/providers/list/opencode/opencode-auth.provider.ts
server/modules/providers/list/opencode/opencode-models.provider.ts
server/modules/providers/tests/mcp.test.ts
server/modules/providers/tests/opencode-models.test.ts
server/modules/providers/tests/provider-models.service.test.ts
server/modules/websocket/services/shell-websocket.service.ts
```

Frontend files:

```text
src/types/app.ts
src/components/chat/hooks/useChatComposerState.ts
src/components/chat/hooks/useChatProviderState.ts
src/components/chat/view/ChatInterface.tsx
src/components/chat/view/subcomponents/ChatComposer.tsx
src/components/chat/view/subcomponents/ChatMessagesPane.tsx
src/components/chat/view/subcomponents/CommandMenu.tsx
src/components/chat/view/subcomponents/CommandResultModal.tsx
src/components/chat/view/subcomponents/MessageComponent.tsx
src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx
src/components/chat/view/subcomponents/TokenUsageSummary.tsx
src/components/llm-logo-provider/SessionProviderLogo.tsx
src/components/mcp/constants.ts
src/components/onboarding/view/subcomponents/AgentConnectionsStep.tsx
src/components/provider-auth/hooks/useProviderAuthStatus.ts
src/components/provider-auth/types.ts
src/components/provider-auth/view/ProviderLoginModal.tsx
src/components/settings/constants/constants.ts
src/components/settings/hooks/useSettingsController.ts
src/components/settings/types/types.ts
src/components/settings/view/Settings.tsx
src/components/settings/view/tabs/agents-settings/AgentListItem.tsx
src/components/settings/view/tabs/agents-settings/AgentsSettingsTab.tsx
src/components/settings/view/tabs/agents-settings/sections/AgentCategoryContentSection.tsx
src/components/settings/view/tabs/agents-settings/sections/AgentSelectorSection.tsx
src/components/settings/view/tabs/agents-settings/sections/content/AccountContent.tsx
src/components/settings/view/tabs/agents-settings/sections/content/PermissionsContent.tsx
src/components/settings/view/tabs/agents-settings/types.ts
src/components/shell/hooks/useShellConnection.ts
src/components/shell/types/types.ts
src/components/shell/utils/socket.ts
src/components/skills/view/ProviderSkills.tsx
```

Documentation and env:

```text
.env.example
README.md
docs/replay/local-provider-replay.md
```

Do not include alternate runtime files in this replay checklist.

## Validation Checks

Run after applying the replay:

```bash
npm run typecheck
npx eslint \
  server/antigravity-cli.js \
  server/modules/providers/list/antigravity/*.ts \
  server/modules/providers/list/opencode/opencode-auth.provider.ts \
  server/modules/providers/list/opencode/opencode-models.provider.ts \
  server/modules/providers/list/opencode/opencode-config.ts \
  server/modules/providers/provider.registry.ts \
  server/modules/providers/provider.routes.ts \
  server/modules/providers/services/provider-capabilities.service.ts \
  server/modules/providers/services/provider-models.service.ts \
  server/modules/providers/services/session-synchronizer.service.ts \
  server/modules/providers/services/sessions-watcher.service.ts \
  server/routes/agent.js \
  server/routes/commands.js \
  src/components/chat/hooks/useChatComposerState.ts \
  src/components/chat/hooks/useChatProviderState.ts \
  src/components/chat/view/ChatInterface.tsx \
  src/components/chat/view/subcomponents/ChatComposer.tsx \
  src/components/chat/view/subcomponents/CommandMenu.tsx \
  src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx \
  src/components/chat/view/subcomponents/TokenUsageSummary.tsx \
  src/components/provider-auth/view/ProviderLoginModal.tsx \
  src/components/settings/view/tabs/agents-settings/AgentsSettingsTab.tsx
git diff --check
npm run build
```

Run targeted tests:

```bash
node --test server/modules/providers/tests/antigravity-sessions.test.ts
node --test server/modules/providers/tests/opencode-models.test.ts
node --test server/modules/providers/tests/provider-models.service.test.ts
node --test server/modules/providers/tests/provider-routes.test.ts
node --test server/modules/providers/tests/mcp.test.ts
```

Run local smoke checks:

```bash
npm run dev
curl -fsS http://localhost:3221/health
agy --version
agy models
opencode --version
opencode models
```

Manual UI checks:

- Settings > Agents shows Claude, Cursor, Codex, Gemini, Antigravity, and OpenCode.
- Antigravity auth status reports installed/authenticated when `agy models` succeeds.
- OpenCode auth status reports config-backed authentication when `~/opencode.json` contains models.
- OpenCode model picker includes `ollama/qwen3-coder:latest` when present in `~/opencode.json`.
- Model picker opens with provider groups collapsed.
- Expanding and collapsing provider groups works.
- Searching models expands matching provider groups.
- Typing `/` in chat opens the full command selector above the composer.
- The slash command selector is not clipped and the trigger tooltip is hidden while open.
- Antigravity sessions appear after `agy` writes DB files under `~/.gemini/antigravity-cli/conversations/`.
- Antigravity token usage shows context numbers after a conversation has enough state for `/context`.

## Replay Cautions

- Keep local CLI execution direct. Do not add SSH, bind-mounted binary, or proxy assumptions.
- Use `ANTIGRAVITY_PATH` and `OPENCODE_PATH` for runtime overrides because the server reads those names.
- Keep `OPENCODE_CONFIG` optional; the app should work from `~/opencode.json` without extra env.
- Keep OpenCode model catalogs uncached or refreshable so local config edits become visible.
- Avoid broad provider allow-lists that forget `antigravity`; prefer the shared provider registry.
- Do not treat missing OpenCode token columns as fatal. Older schemas should return unsupported token usage.
- Do not trust raw Antigravity DB strings blindly. Keep filtering for tool echoes, opaque session fragments, and duplicate assistant text.
- Do not store secrets or local auth files in the repo.
- Use Conventional Commit messages, for example `feat: add antigravity and opencode local providers`.
