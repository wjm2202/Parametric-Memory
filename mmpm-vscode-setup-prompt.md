# Set up MCP to use Parametric-Memory (MMPM) from VSCode

I have a Parametric-Memory (MMPM) server running locally via Docker on `http://localhost:3000`. I need you to connect this project to it via MCP so that AI assistants (Copilot, Claude) can use persistent memory.

## Step 1 — Get the API key

The API key is in the Parametric-Memory repo's `.env` file. Find the line:

```
MMPM_API_KEY=<value>
```

Copy that value. If you don't have one yet, generate one:

```bash
openssl rand -hex 32
```

Then add it to both the Parametric-Memory `.env` and this project's `.env`.

## Step 2 — Add MMPM connection to this project's .env

Add these lines to your project's `.env` file (create it if it doesn't exist):

```
MMPM_URL=http://localhost:3000
MMPM_API_KEY=<paste-your-key-here>
```

## Step 3 — Create .vscode/mcp.json

Create `.vscode/mcp.json` in this project with:

```json
{
  "servers": {
    "parametric-memory": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "mcp:serve"],
      "cwd": "/path/to/Parametric-Memory",
      "env": {
        "MMPM_MCP_BASE_URL": "http://127.0.0.1:3000",
        "MMPM_MCP_API_KEY": "${env:MMPM_API_KEY}",
        "MMPM_MCP_ENABLE_MUTATIONS": "1"
      }
    }
  }
}
```

Replace `cwd` with the actual absolute path to where Parametric-Memory is cloned on your machine.

`MMPM_MCP_ENABLE_MUTATIONS=1` enables write tools so AI can save memory. Without it, memory is read-only.

## Step 4 — Verify the connection

Once VSCode reloads the MCP config, the AI assistant should have access to these tools:

- `memory_ready` — confirms server is up
- `memory_session_bootstrap` — loads all memory context in one call
- `session_checkpoint` — saves atoms, tombstones old state, trains Markov sequences, and commits
- `memory_atoms_list` — browse stored atoms by type or prefix

Test by asking the AI: "Call memory_ready and tell me what you get."

Expected response: `{"ready": true, "mutationsEnabled": true}`

## Step 5 — Verify the server is running

The Docker container should already be running. Confirm with:

```bash
curl -s http://localhost:3000/ready
```

If it returns `{"ready":true}`, you're good. If not:

```bash
cd /path/to/Parametric-Memory
docker-compose up -d
```

## What this gives you

Once connected, AI assistants can:

- **Remember** facts, decisions, and corrections across sessions
- **Recall** context automatically at session start via `memory_session_bootstrap`
- **Learn** from your corrections and store them as procedures
- **Prove** what they knew — every atom has a cryptographic Merkle proof

The memory server stores data at `~/.mmpm/data` on your machine. It's shared across all projects — the same memory is available everywhere MCP is configured.
