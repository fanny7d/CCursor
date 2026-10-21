> **NAS fork — installer 0.1.3 / extension 0.1.2:** quit Cursor and use this fork's `update` to check compatibility and sign the macOS application transactionally. After an official Cursor update, run `verify`; if it fails, quit Cursor and run `repair`. See [DEVELOPMENT.md](DEVELOPMENT.md).

> **fanny7d development fork** — Cursor 3.25.9 / NAS BYOK compatibility fixes, with the upstream AGPL-3.0-or-later license retained. See [DEVELOPMENT.md](DEVELOPMENT.md) for build/install instructions and [the provider example](examples/providers.nas.example.json).

<p align="center">
  English | <a href="README_CN.md">中文</a>
</p>

<p align="center">
  <img src="ccursor.png" width="120" alt="Cursor++" />
</p>

<h1 align="center">Cursor++</h1>

<p align="center">
  <strong>Bring Your Own Key for Cursor IDE</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cometix/ccursor"><img src="https://img.shields.io/npm/v/@cometix/ccursor" alt="npm" /></a>
</p>

---

## What is Cursor++?

Cursor++ lets you use **your own LLM API keys** (Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible provider) with [Cursor IDE](https://cursor.com), bypassing the official subscription. It runs a local BYOK server inside Cursor's extension host, intercepts ConnectRPC/REST traffic, and routes LLM requests to your configured providers.

---

## Quick Start

```bash
git clone --branch fanny7d/cursor-3259-nas https://github.com/fanny7d/CCursor.git
cd CCursor/Cursor++
pnpm install --frozen-lockfile
cd ../installer
npm ci
npm run build:all
node dist/cli.cjs check
# Close Cursor before applying this fork's installer:
node dist/cli.cjs install
# Restart Cursor and configure your API provider in the Cursor++ panel.
```

---

## Features

- **BYOK Mode Toggle** — Sidebar one-click switch between BYOK and official Cursor
- **Multi-Provider** — Anthropic, OpenAI (Chat + Responses API), Google Gemini, or any compatible endpoint
- **Full Agent Mode** — Tool calling, multi-turn conversations, auto-summarization, checkpoint persistence
- **Model Config UI** — Visual provider/model management with thinking level, context limits, variant display
- **Error Banner** — LLM errors surface as Cursor's native retry banner with retryable/non-retryable classification
- **Per-Window Logging** — Each window gets its own log stream, colored output in LogOutputChannel
- **Hot-Reload** — Config changes take effect without restarting Cursor
- **22 Agent Tools** — Shell, Read, Grep, Glob, StrReplace, Write, Task, MCP, etc.
- **Hub Integration** — Device authorization via LinuxDO Connect

---

## How It Works

```
Cursor IDE
  │
  ├─ inject-patch (renderer)
  │   └─ intercept ConnectRPC + REST → route to BYOK server
  │
  ├─ always-local-patch (extension host)
  │   └─ rewrite http/https.request + hot-reload from routes.json
  │
  └─ Cursor++ Extension (BYOK Server @ 127.0.0.1:9960)
      ├─ Fastify + ConnectRPC (27 services)
      ├─ LLM: Anthropic / OpenAI / Gemini SDK
      ├─ Agent: multi-round tool-calling orchestrator
      └─ Config: ~/.ccursor/providers.json + routes.json
```

All patches create backup files and are fully reversible via `uninstall`.

---

## Configuration

Config files are stored in `~/.ccursor/`:

| File | Purpose |
|---|---|
| `providers.json` | LLM provider endpoints, API keys, and model definitions |
| `routes.json` | BYOK mode toggle + redirect whitelist |
| `cursor.db` | Conversation persistence (SQLite) |

### Provider Example

```json
{
  "providers": [
    {
      "id": "my-anthropic",
      "name": "Anthropic",
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "auth": { "kind": "apiKey", "value": "sk-ant-..." },
      "models": [
        {
          "id": "claude-sonnet-4",
          "apiModel": "claude-sonnet-4-20250514",
          "displayName": "Claude Sonnet 4",
          "thinking": true,
          "thinkingLevel": "medium",
          "contextTokenLimit": 200000,
          "defaultOn": true
        }
      ]
    }
  ]
}
```

---

## Platform Support

| Platform | Status |
|---|---|
| macOS (ARM / Intel) | ✅ |
| Linux | ✅ |
| Windows | ✅ |

Requires **Cursor IDE** + **Node.js >= 18**.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| Cannot sign in after install | Toggle BYOK OFF in sidebar panel, then sign in normally |
| Model not found | Add the model in the sidebar panel or edit `~/.ccursor/providers.json` |
| LLM 401/403/404 | Check API key and base URL in providers.json |

---

## Issues & Feedback

This fork contains the extension and installer source for continued development. Upstream: [CometixSpace/CCursor](https://github.com/CometixSpace/CCursor).

- [Fork Issues](https://github.com/fanny7d/CCursor/issues)
- [LinuxDO Discussion](https://linux.do/t/topic/1926833)

---

<p align="center">
  <a href="https://ccursor.cometix.dev">Hub</a> · <a href="https://www.npmjs.com/package/@cometix/ccursor">npm</a>
</p>
