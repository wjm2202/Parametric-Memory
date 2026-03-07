#!/usr/bin/env bash
# ── MMPM Project Scaffold ─────────────────────────────────────────────────────
#
#   Creates a new TypeScript project pre-wired to use MMPM memory.
#
#   Usage:
#     mkdir my-new-project && cd my-new-project
#     bash /path/to/new-project.sh
#
#   What it creates:
#     .env              MMPM connection config (edit API key if needed)
#     CLAUDE.md         Instructs Claude to load/save memory each session
#     tsconfig.json     Sensible TypeScript defaults
#     src/index.ts      Entry point with memory client example
#     package.json      npm init with ts-node, typescript, @types/node
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_NAME="${1:-$(basename "$PWD")}"
MMPM_URL="${MMPM_URL:-http://localhost:3000}"
MMPM_API_KEY="${MMPM_API_KEY:-9b1f7c4a2e8d6f30c5a1b9e2d7f4a8c16e3b0d9f2a7c4e8b1d6f3a9c2e7b4d10}"

echo "→ Scaffolding '$PROJECT_NAME' with MMPM memory support..."

# ── 1. package.json ───────────────────────────────────────────────────────────
if [[ ! -f package.json ]]; then
  npm init -y --quiet 2>/dev/null || true
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json','utf8'));
    p.name = '$PROJECT_NAME';
    p.scripts = { build: 'tsc', dev: 'ts-node src/index.ts', start: 'node dist/index.js', clean: 'rm -rf dist' };
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

# ── 4. .env ───────────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  cat > .env << EOF
# MMPM Memory Server
MMPM_URL=$MMPM_URL
MMPM_API_KEY=$MMPM_API_KEY
EOF
  echo "  ✓ .env"
fi

# ── 5. .gitignore ─────────────────────────────────────────────────────────────
if [[ ! -f .gitignore ]]; then
  cat > .gitignore << 'EOF'
node_modules/
dist/
.env
*.js.map
EOF
  echo "  ✓ .gitignore"
fi

# ── 6. CLAUDE.md ──────────────────────────────────────────────────────────────
cat > CLAUDE.md << EOF
# $PROJECT_NAME

## Memory

This project uses MMPM (Parametric Memory) for persistent cross-session context.

### At the start of every session

Load memory context before doing anything else:

\`\`\`bash
curl -s -H "Authorization: Bearer \$MMPM_API_KEY" \$MMPM_URL/memory/context
\`\`\`

Summarise what you know about this project, recent decisions, and where we left off.
Then walk the Markov chain for associated context:

\`\`\`bash
curl -s -X POST \\
  -H "Authorization: Bearer \$MMPM_API_KEY" \\
  -H "Content-Type: application/json" \\
  \$MMPM_URL/access \\
  -d '{"data":"v1.event.session_started"}'
\`\`\`

### During a session

Save anything worth remembering immediately — decisions, discoveries, state changes:

\`\`\`bash
curl -s -X POST \\
  -H "Authorization: Bearer \$MMPM_API_KEY" \\
  -H "Content-Type: application/json" \\
  \$MMPM_URL/atoms \\
  -d '{"atoms":["v1.fact.example_atom"]}'

curl -s -X POST -H "Authorization: Bearer \$MMPM_API_KEY" \$MMPM_URL/admin/commit
\`\`\`

### At the end of every session

1. Store a fact summarising what was accomplished
2. Tombstone any states that are now complete
3. Store the new active state
4. Train the session arc so next cold-start predicts the right context:

\`\`\`bash
curl -s -X POST \\
  -H "Authorization: Bearer \$MMPM_API_KEY" \\
  -H "Content-Type: application/json" \\
  \$MMPM_URL/train \\
  -d '{"sequence":["v1.event.session_started","v1.state.current_task","v1.event.accomplishment"]}'
\`\`\`

### Atom naming convention for this project

Use the project name as a namespace prefix in state/fact atoms:
- \`v1.fact.${PROJECT_NAME}_description_of_fact\`
- \`v1.state.${PROJECT_NAME}_current_task\`
- \`v1.event.${PROJECT_NAME}_milestone_date\`
- \`v1.relation.${PROJECT_NAME}_A_relates_to_B\`

### MMPM server

- URL: \`$MMPM_URL\`
- Health: \`$MMPM_URL/health\`
- The server must be running before any memory operations. Start it with:
  \`cd /path/to/markov-merkle-memory && ./start.sh\`
EOF
echo "  ✓ CLAUDE.md"

# ── 7. src/index.ts ───────────────────────────────────────────────────────────
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

# ── 8. Install TypeScript deps ────────────────────────────────────────────────
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
echo "    1. Make sure MMPM is running:  cd /path/to/markov-merkle-memory && ./start.sh"
echo "    2. Edit .env if your API key differs"
echo "    3. Open in Claude — it will load memory context automatically via CLAUDE.md"
echo "    4. npm run dev   to run the example"
echo ""
