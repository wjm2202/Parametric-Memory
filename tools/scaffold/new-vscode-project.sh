#!/usr/bin/env bash
# ── MMPM VSCode Project Scaffold ──────────────────────────────────────────────
#
#   Creates a new TypeScript project pre-wired to MMPM memory, with a full
#   VSCode workspace: settings, recommended extensions, and tasks for memory
#   load/save/commit available from the Command Palette.
#
#   Usage:
#     mkdir my-new-project && cd my-new-project
#     bash /path/to/new-vscode-project.sh [project-name]
#
#   What it creates:
#     .env                           MMPM connection config
#     .gitignore                     node_modules, dist, .env
#     CLAUDE.md                      Instructs Claude to load/save memory
#     package.json                   build / dev / start / clean scripts
#     tsconfig.json                  Sensible TypeScript defaults
#     src/index.ts                   Entry point with memory client example
#     .vscode/settings.json          Editor defaults + ts/eslint integration
#     .vscode/mcp.json               MCP server config (GitHub Copilot / VS Code 1.99+)
#     .vscode/extensions.json        Recommended extensions list
#     .vscode/tasks.json             Memory tasks in Command Palette
#     .vscode/launch.json            Debug config for ts-node
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_NAME="${1:-$(basename "$PWD")}"
MMPM_URL="${MMPM_URL:-http://localhost:3000}"
MMPM_API_KEY="${MMPM_API_KEY:-9b1f7c4a2e8d6f30c5a1b9e2d7f4a8c16e3b0d9f2a7c4e8b1d6f3a9c2e7b4d10}"

echo "→ Scaffolding VSCode project '$PROJECT_NAME' with MMPM memory support..."

# ── 1. package.json ───────────────────────────────────────────────────────────
if [[ ! -f package.json ]]; then
  npm init -y --quiet 2>/dev/null || true
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json','utf8'));
    p.name = '$PROJECT_NAME';
    p.scripts = {
      build: 'tsc',
      dev: 'ts-node src/index.ts',
      start: 'node dist/index.js',
      clean: 'rm -rf dist'
    };
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
  "
  echo "  ✓ package.json"
fi

# ── 2. tsconfig.json ──────────────────────────────────────────────────────────
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF
echo "  ✓ tsconfig.json"

# ── 3. .env ───────────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  cat > .env << EOF
# MMPM Memory Server
MMPM_URL=$MMPM_URL
MMPM_API_KEY=$MMPM_API_KEY
EOF
  echo "  ✓ .env"
fi

# ── 4. .gitignore ─────────────────────────────────────────────────────────────
if [[ ! -f .gitignore ]]; then
  cat > .gitignore << 'EOF'
node_modules/
dist/
.env
*.js.map
EOF
  echo "  ✓ .gitignore"
fi

# ── 5. CLAUDE.md ──────────────────────────────────────────────────────────────
cat > CLAUDE.md << EOF
# $PROJECT_NAME

## Memory

This project uses MMPM (Parametric Memory) for persistent cross-session context.

### At the start of every session

**If MCP tools are available**, call \`memory_session_bootstrap\` — it returns goals,
constraints, preferences, and relevant memories in one call.

**Curl fallback:**
\`\`\`bash
curl -s -X POST \\
  -H "Authorization: Bearer \$MMPM_API_KEY" \\
  -H "Content-Type: application/json" \\
  \$MMPM_URL/memory/bootstrap \\
  -d '{}'
\`\`\`

After loading, summarise what you know about this project, recent decisions, and
where we left off.

### During a session

Save anything worth remembering immediately — decisions, discoveries, state changes.

**If MCP tools are available**, call \`session_checkpoint\` with atoms to store
(and optionally atoms to tombstone and a Markov sequence to train). It commits
automatically.

**Curl fallback (three calls):**
\`\`\`bash
# 1. Store atoms
curl -s -X POST \\
  -H "Authorization: Bearer \$MMPM_API_KEY" \\
  -H "Content-Type: application/json" \\
  \$MMPM_URL/atoms \\
  -d '{"atoms":["v1.fact.${PROJECT_NAME}_example_fact"]}'

# 2. Train the arc (optional, at least 2 items)
curl -s -X POST \\
  -H "Authorization: Bearer \$MMPM_API_KEY" \\
  -H "Content-Type: application/json" \\
  \$MMPM_URL/train \\
  -d '{"sequence":["v1.event.session_started","v1.fact.${PROJECT_NAME}_example_fact"]}'

# 3. Commit to disk
curl -s -X POST -H "Authorization: Bearer \$MMPM_API_KEY" \$MMPM_URL/admin/commit
\`\`\`

### At the end of every session

**MANDATORY**: always save before ending — decisions made, state reached, what to
pick up next session.

**If MCP tools are available**, call \`session_checkpoint\`:
- \`atoms\` — new facts/states to store
- \`tombstone\` — completed states to remove
- \`train\` — sequence from session start to final state

**Curl fallback**: use the three-call pattern above (store → train → commit).

### Atom naming convention for this project

Use the project name as a namespace prefix:
- \`v1.fact.${PROJECT_NAME}_description_of_fact\`
- \`v1.state.${PROJECT_NAME}_current_task\`
- \`v1.event.${PROJECT_NAME}_milestone_reached\`
- \`v1.relation.${PROJECT_NAME}_A_relates_to_B\`

### MCP tools quick reference

| Tool | When to use |
|---|---|
| \`memory_ready\` | Session start preflight — confirm server is up |
| \`memory_session_bootstrap\` | Session start — loads context + Markov predictions in one call |
| \`session_checkpoint\` | Session end + mid-session saves (atoms + tombstone + train + commit) |
| \`memory_atoms_list\` | Browse stored atoms by type |
| \`memory_access\` | Markov recall for one atom |
| \`memory_atoms_stale\` | Find atoms to clean up |

### MMPM server

- URL: \`$MMPM_URL\`
- Health: \`$MMPM_URL/health\`
- Must be running before any memory operations. Start with:
  \`cd /path/to/markov-merkle-memory && ./start.sh\`

### VSCode tasks

Memory operations are available via the Command Palette (**Ctrl/Cmd+Shift+P → Run Task**):

| Task | What it does |
|---|---|
| MMPM: Bootstrap Memory | Loads full session context (goals, constraints, recent memories) |
| MMPM: Save Atom | Prompts for an atom string and saves it |
| MMPM: Commit Memory | Flushes pending writes to disk |
| MMPM: Health Check | Checks the MMPM server is reachable |
| MMPM: Start Server | Starts the MMPM server (set MMPM_DIR in .env first) |
| MMPM: Stop Server | Stops the running MMPM server |
| MMPM: Backup Memory | Exports all atoms to \`~/.mmpm/backups/\` |
| MMPM: Restore Project Context | Restores atoms from \`memory/project-context.json\` |
EOF
echo "  ✓ CLAUDE.md"

# ── 6. src/index.ts ───────────────────────────────────────────────────────────
mkdir -p src
cat > src/index.ts << 'EOF'
import * as dotenv from 'dotenv';
dotenv.config();

const MMPM_URL = process.env.MMPM_URL ?? 'http://localhost:3000';
const MMPM_API_KEY = process.env.MMPM_API_KEY ?? '';

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${MMPM_API_KEY}`,
};

async function loadMemory(): Promise<void> {
  const res = await fetch(`${MMPM_URL}/memory/context`, { headers });
  if (!res.ok) throw new Error(`Memory load failed: ${res.status}`);
  const ctx = await res.json() as { systemPromptBlock?: string };
  if (ctx.systemPromptBlock) {
    console.log('Memory context loaded:\n', ctx.systemPromptBlock);
  }
}

async function saveAtom(atom: string): Promise<void> {
  await fetch(`${MMPM_URL}/atoms`, {
    method: 'POST', headers,
    body: JSON.stringify({ atoms: [atom] }),
  });
  await fetch(`${MMPM_URL}/admin/commit`, { method: 'POST', headers });
  console.log(`Saved: ${atom}`);
}

async function main(): Promise<void> {
  await loadMemory();
  await saveAtom('v1.event.session_started');
}

main().catch(console.error);
EOF
echo "  ✓ src/index.ts"

# ── 7. .vscode/settings.json ──────────────────────────────────────────────────
mkdir -p .vscode
cat > .vscode/settings.json << 'EOF'
{
  // Editor
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.tabSize": 2,
  "editor.rulers": [100],
  "editor.bracketPairColorization.enabled": true,

  // TypeScript
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  },

  // Files
  "files.exclude": {
    "node_modules": true,
    "dist": true
  },
  "files.watcherExclude": {
    "**/node_modules/**": true,
    "**/dist/**": true
  },

  // Terminal
  "terminal.integrated.env.osx": {
    "MMPM_URL": "${env:MMPM_URL}",
    "MMPM_API_KEY": "${env:MMPM_API_KEY}"
  },
  "terminal.integrated.env.linux": {
    "MMPM_URL": "${env:MMPM_URL}",
    "MMPM_API_KEY": "${env:MMPM_API_KEY}"
  }
}
EOF
echo "  ✓ .vscode/settings.json"

# ── 8. .vscode/mcp.json ───────────────────────────────────────────────────────
# Used by GitHub Copilot (VS Code 1.99+) and other MCP-aware extensions.
# Edit MMPM_DIR in .env to point at your parametric-memory repo, then update
# the args path below to match.
cat > .vscode/mcp.json << EOF
{
  "servers": {
    "parametric-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["\${env:MMPM_DIR}/dist/server.js"],
      "env": {
        "MMPM_API_KEY": "\${env:MMPM_API_KEY}",
        "DB_BASE_PATH": "~/.mmpm/data",
        "LOG_LEVEL": "warn",
        "MMPM_MCP_ENABLE_MUTATIONS": "1"
      }
    }
  }
}
EOF
echo "  ✓ .vscode/mcp.json"

# ── 10. .vscode/extensions.json ───────────────────────────────────────────────
cat > .vscode/extensions.json << 'EOF'
{
  "recommendations": [
    "esbenp.prettier-vscode",
    "dbaeumer.vscode-eslint",
    "ms-vscode.vscode-typescript-next",
    "christian-kohler.npm-intellisense",
    "dotenv.dotenv-vscode",
    "humao.rest-client",
    "rangav.vscode-thunder-client"
  ]
}
EOF
echo "  ✓ .vscode/extensions.json"

# ── 11. .vscode/tasks.json ────────────────────────────────────────────────────
cat > .vscode/tasks.json << EOF
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "MMPM: Bootstrap Memory",
      "type": "shell",
      "command": "source .env 2>/dev/null || true; curl -s -X POST -H \"Authorization: Bearer \\\${MMPM_API_KEY}\" -H \"Content-Type: application/json\" \\\${MMPM_URL}/memory/bootstrap -d '{}' | jq .",
      "group": "none",
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": true
      },
      "problemMatcher": []
    },
    {
      "label": "MMPM: Save Atom",
      "type": "shell",
      "command": "source .env 2>/dev/null || true; read -p 'Atom: ' ATOM; curl -s -X POST -H 'Authorization: Bearer \\\${MMPM_API_KEY}' -H 'Content-Type: application/json' \\\${MMPM_URL}/atoms -d \"{\\\"atoms\\\":[\\\"\\\$ATOM\\\"]}\" | jq .; curl -s -X POST -H 'Authorization: Bearer \\\${MMPM_API_KEY}' \\\${MMPM_URL}/admin/commit | jq .",
      "group": "none",
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": false
      },
      "problemMatcher": []
    },
    {
      "label": "MMPM: Commit Memory",
      "type": "shell",
      "command": "source .env 2>/dev/null || true; curl -s -X POST -H \"Authorization: Bearer \\\${MMPM_API_KEY}\" \\\${MMPM_URL}/admin/commit | jq .",
      "group": "none",
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": false
      },
      "problemMatcher": []
    },
    {
      "label": "MMPM: Health Check",
      "type": "shell",
      "command": "source .env 2>/dev/null || true; curl -s \\\${MMPM_URL}/health | jq .",
      "group": "none",
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": true
      },
      "problemMatcher": []
    },
    {
      "label": "MMPM: Start Server",
      "type": "shell",
      "command": "source .env 2>/dev/null || true; if [[ -z \"\\\${MMPM_DIR:-}\" ]]; then echo 'Set MMPM_DIR in .env to the markov-merkle-memory repo path'; exit 1; fi; bash \"\\\${MMPM_DIR}/start.sh\"",
      "group": "none",
      "isBackground": true,
      "presentation": {
        "reveal": "always",
        "panel": "dedicated",
        "clear": true
      },
      "problemMatcher": {
        "pattern": { "regexp": "^$" },
        "background": {
          "activeOnStart": true,
          "beginsPattern": "Starting",
          "endsPattern": "listening"
        }
      }
    },
    {
      "label": "MMPM: Stop Server",
      "type": "shell",
      "command": "source .env 2>/dev/null || true; if [[ -z \"\\\${MMPM_DIR:-}\" ]]; then echo 'Set MMPM_DIR in .env to the markov-merkle-memory repo path'; exit 1; fi; bash \"\\\${MMPM_DIR}/start.sh\" --stop",
      "group": "none",
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": false
      },
      "problemMatcher": []
    },
    {
      "label": "MMPM: Backup Memory",
      "type": "shell",
      "command": "source .env 2>/dev/null || true; if [[ -z \"\\\${MMPM_DIR:-}\" ]]; then echo 'Set MMPM_DIR in .env to the markov-merkle-memory repo path'; exit 1; fi; cd \"\\\${MMPM_DIR}\" && npm run backup",
      "group": "none",
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": false
      },
      "problemMatcher": []
    },
    {
      "label": "MMPM: Restore Project Context",
      "type": "shell",
      "command": "source .env 2>/dev/null || true; if [[ -z \"\\\${MMPM_DIR:-}\" ]]; then echo 'Set MMPM_DIR in .env to the markov-merkle-memory repo path'; exit 1; fi; cd \"\\\${MMPM_DIR}\" && npm run restore -- --file memory/project-context.json",
      "group": "none",
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": false
      },
      "problemMatcher": []
    },
    {
      "label": "dev",
      "type": "npm",
      "script": "dev",
      "group": { "kind": "build", "isDefault": true },
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": true
      },
      "problemMatcher": ["\$tsc"]
    },
    {
      "label": "build",
      "type": "npm",
      "script": "build",
      "group": "build",
      "presentation": {
        "reveal": "always",
        "panel": "shared",
        "clear": true
      },
      "problemMatcher": ["\$tsc"]
    }
  ]
}
EOF
echo "  ✓ .vscode/tasks.json"

# ── 12. .vscode/launch.json ───────────────────────────────────────────────────
cat > .vscode/launch.json << 'EOF'
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run (ts-node)",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "node",
      "runtimeArgs": ["-r", "ts-node/register"],
      "args": ["${workspaceFolder}/src/index.ts"],
      "cwd": "${workspaceFolder}",
      "envFile": "${workspaceFolder}/.env",
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Debug current file (ts-node)",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "node",
      "runtimeArgs": ["-r", "ts-node/register"],
      "args": ["${file}"],
      "cwd": "${workspaceFolder}",
      "envFile": "${workspaceFolder}/.env",
      "sourceMaps": true,
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
EOF
echo "  ✓ .vscode/launch.json"

# ── 13. Install TypeScript deps ───────────────────────────────────────────────
echo "  Installing TypeScript dependencies..."
if npm install --save-dev typescript ts-node @types/node --quiet 2>/dev/null; then
  echo "  ✓ dependencies installed"
else
  echo "  ⚠ npm install failed — run 'npm install --save-dev typescript ts-node @types/node' manually"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "  Project '$PROJECT_NAME' ready."
echo ""
echo "  Next steps:"
echo "    1. Make sure MMPM is running:"
echo "       cd /path/to/markov-merkle-memory && ./start.sh"
echo "    2. Edit .env — update MMPM_API_KEY and optionally add:"
echo "       MMPM_DIR=/path/to/markov-merkle-memory"
echo "    3. Open in VSCode:  code ."
echo "    4. Ctrl/Cmd+Shift+P → 'Run Task' → 'MMPM: Health Check' to verify"
echo "    5. Open in Claude — it will load memory context automatically via CLAUDE.md"
echo "    6. npm run dev   to run the example"
echo ""
