# Parametric-Memory — VSCode Integration

Connect MMPM to VSCode so your AI assistant has persistent, verifiable memory across every coding session.

---

## Option 1 — MCP server (recommended for Copilot / Cline / Continue)

MMPM ships a full [Model Context Protocol](https://modelcontextprotocol.io/) server. Any MCP-compatible VSCode extension can connect to it.

### Step 1: Start MMPM

```bash
cd your-parametric-memory-repo
./start.sh
# Server up at http://localhost:3000
```

### Step 2: Start the MCP server

```bash
# Read-only (safe for shared machines)
npm run mcp:serve

# Read + write (full memory access)
npm run mcp:serve:unsafe
```

The MCP server listens on stdio and exposes all MMPM operations as typed tools.

### Step 3: Configure your extension

**For [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev) or [Continue](https://marketplace.visualstudio.com/items?itemName=Continue.continue):**

Add to your extension's MCP config (usually `~/.cline/config.json` or `~/.continue/config.json`):

```json
{
  "mcpServers": {
    "parametric-memory": {
      "command": "node",
      "args": ["/absolute/path/to/parametric-memory/dist/server.js"],
      "env": {
        "MMPM_API_KEY": "your-api-key-from-.env",
        "PORT": "3000"
      }
    }
  }
}
```

**For [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) (VSCode MCP support):**

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "parametric-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["${env:HOME}/parametric-memory/dist/server.js"],
      "env": {
        "MMPM_API_KEY": "${env:MMPM_API_KEY}"
      }
    }
  }
}
```

Or add to your VSCode `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "parametric-memory": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/parametric-memory/dist/server.js"],
        "env": {
          "MMPM_API_KEY": "your-api-key"
        }
      }
    }
  }
}
```

---

## Option 2 — CLAUDE.md (for Claude Code in terminal)

If you use [Claude Code](https://docs.anthropic.com/claude-code) in your terminal, drop a `CLAUDE.md` file in your project root so Claude automatically connects to MMPM at session start.

Copy `integrations/vscode/CLAUDE.md.template` to your project root as `CLAUDE.md` and edit the paths:

```bash
cp integrations/vscode/CLAUDE.md.template ./CLAUDE.md
# Edit MMPM_PATH and MMPM_API_KEY in CLAUDE.md
```

Claude Code reads `CLAUDE.md` automatically and will load your memory context on every session start.

---

## Option 3 — Tasks / snippets

Add to `.vscode/tasks.json` in your project to start/stop MMPM as a VSCode task:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "MMPM: Start server",
      "type": "shell",
      "command": "${env:HOME}/parametric-memory/start.sh",
      "group": "build",
      "presentation": { "panel": "dedicated", "reveal": "always" },
      "isBackground": true,
      "problemMatcher": []
    },
    {
      "label": "MMPM: Stop server",
      "type": "shell",
      "command": "curl -s -X POST http://localhost:3000/admin/shutdown || pkill -f 'dist/server.js'",
      "group": "build"
    }
  ]
}
```

---

## Verify it's working

```bash
curl http://localhost:3000/health
# → {"status":"ok","ready":true,...}
```

Open the VSCode command palette → your AI extension → look for `parametric-memory` in the available tools list.

---

## More information

- GitHub: https://github.com/wjm2202/Parametric-Memory
- Website: https://parametric-memory.dev
- Claude Cowork skill: `integrations/claude-skill/SKILL.md`
