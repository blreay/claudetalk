# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClaudeTalk is a multi-channel chatbot that connects Claude Code to IM platforms (DingTalk, Feishu, Discord). Users interact with Claude Code through these chat platforms, supporting multi-turn conversations with session persistence.

## Commands

```bash
# Build the project (compiles TypeScript + copies templates)
npm run build

# Run in development mode (uses bun)
npm run dev

# Type check only
npm run type-check

# Run tests
npm test
```

## Architecture

### Entry Points
- **CLI**: `src/cli.ts` - Handles `--setup`, `--profile`, and orchestrates bot startup
- **Runtime**: `src/index.ts` - `startBot()` function that initializes channels and registers message handlers

### Channel Abstraction (Plugin System)
The project uses a registry pattern to support multiple IM platforms. To add a new channel:

1. Create `src/channels/{name}/index.ts`
2. Implement the `Channel` interface from `src/types.ts`
3. Call `registerChannel(descriptor)` at the end of the file
4. Add one export line in `src/channels/index.ts`

Existing channels: `dingtalk/`, `feishu/`, `discord/`

### Core Modules
- **`src/core/claude.ts`**: Spawns `claude -p` CLI subprocess, manages session persistence (`.claudetalk-sessions.json`), handles SubAgent configuration
- **`src/core/logger.ts`**: Per-profile logging with timestamps

### Data Flow
```
IM Platform (WebSocket/Stream) → Channel Implementation → callClaude() → Claude Code CLI → Response → Channel.sendMessage()
```

### Session Management
- Sessions stored in `{workDir}/.claudetalk-sessions.json`
- Key format: `conversationId|workDir|profile|channel`
- Sessions auto-resume on restart; `/new` or `/reset` clears them

### Multi-Agent Collaboration (Peer Message)
When multiple bots run on the same machine:
- Bot A mentions Bot B in response
- Message written to `{workDir}/.claudetalk/{channel}/bot_{targetProfile}.json`
- Target bot polls every 10 seconds and processes the message

### SubAgent Support
- Profile config in `.claudetalk.json` with `subagentEnabled: true`
- Agent definition file: `{workDir}/.claude/agents/{profileName}.md`
- YAML frontmatter format: `name`, `description`, `model`, `tools`, `disallowedTools`

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry, setup wizard, profile management |
| `src/index.ts` | Bot startup, channel factory, message routing |
| `src/types.ts` | TypeScript interfaces for Channel, Config, Messages |
| `src/channels/registry.ts` | Channel descriptor registration and lookup |
| `src/core/claude.ts` | Claude CLI invocation, session management |

## Configuration

Project config stored in `.claudetalk.json` at the working directory:

```json
{
  "profiles": {
    "pm": {
      "channel": "feishu",
      "feishu": { "FEISHU_APP_ID": "...", "FEISHU_APP_SECRET": "..." },
      "systemPrompt": "你是产品经理",
      "subagentEnabled": true,
      "subagentModel": "claude-sonnet-4-5"
    }
  }
}
```

Run `claudetalk --setup` for interactive configuration.