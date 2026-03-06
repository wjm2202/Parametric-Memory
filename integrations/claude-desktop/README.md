# Parametric-Memory — Claude Desktop Integration

Connect MMPM to Claude Desktop so every conversation has persistent, verifiable memory.

---

## Setup

### Step 1: Build MMPM

```bash
cd your-parametric-memory-repo
npm run setup
```

This installs dependencies, compiles TypeScript, and creates a `.env` from the example.

### Step 2: Edit the MCP config

Copy `claude_desktop_config.json.example` and edit the path:

```bash
cp integrations/claude-desktop/claude_desktop_config.json.example /tmp/mmpm-mcp-config.json
# Edit /tmp/mmpm-mcp-config.json — replace /EDIT_THIS_PATH with the actual repo path
```

### Step 3: Add to Claude Desktop

**macOS:**

```bash
# Config file location:
# ~/Library/Application Support/Claude/claude_desktop_config.json

# Merge the mcpServers entry into your existing config, or create the file:
cp /tmp/mmpm-mcp-config.json \
  ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Windows:**

```
Config file location:
%APPDATA%\Claude\claude_desktop_config.json
```

Update the `args` path to use Windows-style paths, e.g.:

```json
"args": ["C:\\Users\\YourName\\parametric-memory\\dist\\server.js"]
```

### Step 4: Restart Claude Desktop

Quit and reopen Claude Desktop. Open Settings → Developer → MCP Servers — you should see `parametric-memory` listed.

### Step 5: Start the MMPM server

Claude Desktop will attempt to start the MCP server automatically using the `command` and `args` in the config. If you prefer to run it manually:

```bash
cd your-parametric-memory-repo
./start.sh
```

---

## Verify it's working

In Claude Desktop, open a new conversation and ask:

> "Check my MMPM memory and tell me what you find."

Claude will call the MMPM MCP tools to load your memory context and report back.

---

## Config reference

| Field | Description |
|-------|-------------|
| `command` | Must be `node` (Node.js runtime) |
| `args[0]` | Absolute path to `dist/server.js` in your repo |
| `MMPM_API_KEY` | Must match the key in your `.env` file |
| `PORT` | HTTP port MMPM listens on (default: 3000) |
| `LOG_LEVEL` | Set to `warn` for quiet operation, `info` for verbose |

---

## More information

- GitHub: https://github.com/wjm2202/Parametric-Memory
- Website: https://parametric-memory.dev
- VSCode integration: `integrations/vscode/README.md`
- Claude Cowork skill: `integrations/claude-skill/SKILL.md`
