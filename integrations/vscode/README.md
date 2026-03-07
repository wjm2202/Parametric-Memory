# Parametric-Memory — VSCode Integration

Connect MMPM to VSCode so your AI assistant has persistent, verifiable memory across every coding session.

Memory lives at `~/.mmpm/data` — outside your repo, shared by Docker, `./start.sh`, and every MCP client.

> ⚠️ **Never run `docker compose down -v`** — the `-v` flag destroys volumes.
> Use `docker compose down` to stop safely. Recovery: `npm run restore -- --file memory/project-context.json`

---

## Option 1 — MCP server (recommended)

MMPM ships a full [Model Context Protocol](https://modelcontextprotocol.io/) server. Any MCP-compatible extension can connect to it and get full memory access including automatic session capture via `session_checkpoint`.

### Step 1: Start MMPM

```bash
cd your-parametric-memory-repo
./start.sh
# Server up at http://localhost:3000
```

### Step 2: Configure your extension

All configs below include `MMPM_MCP_ENABLE_MUTATIONS=1` (required for `session_checkpoint` and all write tools) and `DB_BASE_PATH=~/.mmpm/data` (shared with Docker and `./start.sh`).

---

**For [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev) or [Continue](https://marketplace.visualstudio.com/items?itemName=Continue.continue):**

Add to your extension's MCP config (`~/.cline/config.json` or `~/.continue/config.json`):

```json
{
  "mcpServers": {
    "parametric-memory": {
      "command": "node",
      "args": ["/EDIT_THIS_PATH/parametric-memory/dist/server.js"],
      "env": {
        "MMPM_API_KEY": "your-api-key-from-.env",
        "PORT": "3000",
        "DB_BASE_PATH": "~/.mmpm/data",
        "LOG_LEVEL": "warn",
        "MMPM_MCP_ENABLE_MUTATIONS": "1"
      }
    }
  }
}
```

---

**For [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) — `.vscode/mcp.json`:**

```json
{
  "servers": {
    "parametric-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["${env:HOME}/parametric-memory/dist/server.js"],
      "env": {
        "MMPM_API_KEY": "${env:MMPM_API_KEY}",
        "DB_BASE_PATH": "~/.mmpm/data",
        "LOG_LEVEL": "warn",
        "MMPM_MCP_ENABLE_MUTATIONS": "1"
      }
    }
  }
}
```

---

**VSCode `settings.json` (user or workspace):**

```json
{
  "mcp": {
    "servers": {
      "parametric-memory": {
        "type": "stdio",
        "command": "node",
        "args": ["/EDIT_THIS_PATH/parametric-memory/dist/server.js"],
        "env": {
          "MMPM_API_KEY": "your-api-key-from-.env",
          "DB_BASE_PATH": "~/.mmpm/data",
          "LOG_LEVEL": "warn",
          "MMPM_MCP_ENABLE_MUTATIONS": "1"
        }
      }
    }
  }
}
```

### Step 3: Verify

Open the VSCode command palette → your AI extension → confirm `parametric-memory` appears in the available tools list. You should see tools including `session_checkpoint`, `memory_session_bootstrap`, and `memory_atoms_list`.

### Key MCP tools

| Tool | When to use |
|------|-------------|
| `memory_session_bootstrap` | Session start — loads context + Markov predictions in one call |
| `session_checkpoint` | Session end + mid-session — saves atoms, tombstones old ones, trains arc, commits |
| `memory_atoms_list` | Browse memory by type (`fact`, `state`, `event`, etc.) |
| `memory_search` | Full-text search across all stored atoms |
| `memory_access` | Markov recall for one atom |
| `memory_atoms_stale` | Find atoms to clean up |
| `memory_ready` | Confirm server is up and mutations are enabled (use at session start) |
| `memory_verify` | Verify a Merkle proof |

Full tool reference: `integrations/claude-skill/SKILL.md`

---

## Option 2 — CLAUDE.md (for Claude Code in terminal)

If you use [Claude Code](https://docs.anthropic.com/claude-code) in your terminal, drop a `CLAUDE.md` file in your project root. Claude Code reads it automatically at session start.

```bash
cp integrations/vscode/CLAUDE.md.template ./CLAUDE.md
# Edit MMPM_PATH and MMPM_API_KEY in CLAUDE.md
```

The template instructs Claude to use **MCP tools when available** (via Claude Code's MCP config) and fall back to curl when not. See `CLAUDE.md.template` for details.

To wire Claude Code's MCP config, add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "parametric-memory": {
      "command": "node",
      "args": ["/EDIT_THIS_PATH/parametric-memory/dist/server.js"],
      "env": {
        "MMPM_API_KEY": "your-api-key-from-.env",
        "DB_BASE_PATH": "~/.mmpm/data",
        "LOG_LEVEL": "warn",
        "MMPM_MCP_ENABLE_MUTATIONS": "1"
      }
    }
  }
}
```

---

## Option 3 — VSCode tasks

Add to `.vscode/tasks.json` for quick access from the Command Palette:

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
      "command": "${env:HOME}/parametric-memory/start.sh --stop",
      "group": "build"
    },
    {
      "label": "MMPM: Backup memory",
      "type": "shell",
      "command": "cd ${env:HOME}/parametric-memory && npm run backup",
      "group": "build"
    },
    {
      "label": "MMPM: Restore project context",
      "type": "shell",
      "command": "cd ${env:HOME}/parametric-memory && npm run restore -- --file memory/project-context.json",
      "group": "build"
    }
  ]
}
```

---

## More information

- GitHub: https://github.com/wjm2202/Parametric-Memory
- Website: https://parametric-memory.dev
- Full MCP tool reference: `integrations/claude-skill/SKILL.md`
- Claude operating guide: `CLAUDE.md`
