const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function parseEnvFile(path) {
  try {
    const txt = readFileSync(path, 'utf8');
    const out = {};
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

function slug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'na';
}

function toParsed(result) {
  const text = ('content' in result ? (result.content.find(i => i.type === 'text') || {}).text : '') || '';
  try {
    return { isError: !!result.isError, data: JSON.parse(text) };
  } catch {
    return { isError: !!result.isError, data: text };
  }
}

function buildSprintAtoms(planText) {
  const atoms = [];
  const relations = [];
  const sequence = [];

  atoms.push('v1.fact.sprint.board_mmpm_refactor_source_mmpm_refactor_plan_conf_high_scope_project_dt_2026_03_04');
  atoms.push('v1.state.sprint.board_status_active_scope_project_src_repo_conf_high_dt_2026_03_04');

  const statusMap = { x: 'done', '~': 'in_progress', ' ': 'todo', '!': 'blocked' };
  const lines = planText.split(/\r?\n/);

  for (const line of lines) {
    const m = line.match(/^(\d+\.\d+)\s+\[(.| )\]\s+P(\d)\s+\|\s+Size:\s+([A-Z]+)\s+\|\s+(.+)$/);
    if (!m) continue;
    const [, storyId, rawStatus, priority, size, title] = m;
    const statusKey = (rawStatus || ' ').trim();
    const status = statusMap[statusKey] || 'todo';
    const titleSlug = slug(title);

    const itemAtom = `v1.fact.sprint.item_${storyId.replace('.', '_')}_${titleSlug}_priority_p${priority}_size_${size.toLowerCase()}_status_${status}_src_plan_conf_high_scope_project_dt_2026_03_04`;
    const statusAtom = `v1.state.sprint.item_${storyId.replace('.', '_')}_status_${status}_src_plan_conf_high_scope_project_dt_2026_03_04`;

    atoms.push(itemAtom);
    atoms.push(statusAtom);
    sequence.push(itemAtom);

    relations.push(`v1.relation.sprint.board_contains_item_${storyId.replace('.', '_')}_src_plan_conf_high_scope_project_dt_2026_03_04`);
  }

  for (let i = 0; i < sequence.length - 1; i++) {
    const current = sequence[i];
    const next = sequence[i + 1];
    const currentId = current.match(/item_(\d+_\d+)_/)?.[1] || `idx_${i}`;
    const nextId = next.match(/item_(\d+_\d+)_/)?.[1] || `idx_${i + 1}`;
    relations.push(`v1.relation.sprint.sequence_item_${currentId}_precedes_item_${nextId}_src_plan_conf_medium_scope_project_dt_2026_03_04`);
  }

  const uniqueAtoms = Array.from(new Set([...atoms, ...relations]));
  return { uniqueAtoms, trainingSequence: sequence.slice(0, 20), totalStories: sequence.length };
}

async function main() {
  const repoRoot = resolve(__dirname, '..', '..');
  const workspaceRoot = resolve(repoRoot, '..');
  const envFile = parseEnvFile(resolve(repoRoot, '.env'));
  const apiKey = process.env.MMPM_API_KEY || process.env.MMPM_MCP_API_KEY || envFile.MMPM_API_KEY || '';

  const planText = readFileSync(resolve(workspaceRoot, 'MMPM_REFACTOR_PLAN.txt'), 'utf8');
  const { uniqueAtoms, trainingSequence, totalStories } = buildSprintAtoms(planText);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(repoRoot, 'node_modules', 'ts-node', 'dist', 'bin.js'),
      resolve(repoRoot, 'tools', 'mcp', 'mmpm_mcp_server.ts'),
    ],
    cwd: repoRoot,
    env: {
      ...process.env,
      MMPM_MCP_BASE_URL: 'http://127.0.0.1:3000',
      MMPM_MCP_ENABLE_MUTATIONS: '1',
      MMPM_MCP_ENABLE_SEMANTIC_TOOLS: '1',
      ...(apiKey ? { MMPM_MCP_API_KEY: apiKey } : {}),
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'mmpm-sprint-board-loader', version: '1.0.0' });
  await client.connect(transport);

  try {
    const add = toParsed(await client.callTool({ name: 'memory_atoms_add', arguments: { atoms: uniqueAtoms } }));
    const commit = toParsed(await client.callTool({ name: 'memory_commit', arguments: {} }));

    let train = { isError: false, data: { skipped: true, reason: 'not-enough-items' } };
    if (trainingSequence.length >= 2) {
      train = toParsed(await client.callTool({ name: 'memory_train', arguments: { sequence: trainingSequence } }));
    }

    const recallSearch = toParsed(await client.callTool({
      name: 'memory_search',
      arguments: { query: 'mmpm sprint board refactor stories priority status', limit: 10, threshold: 0 }
    }));

    const recallItems = toParsed(await client.callTool({
      name: 'memory_atoms_list',
      arguments: { type: 'fact', prefix: 'v1.fact.sprint.item_', limit: 50, offset: 0 }
    }));

    const recallRelations = toParsed(await client.callTool({
      name: 'memory_atoms_list',
      arguments: { type: 'relation', prefix: 'v1.relation.sprint.', limit: 50, offset: 0 }
    }));

    console.log(JSON.stringify({
      source: 'MMPM_REFACTOR_PLAN.txt',
      parsedStories: totalStories,
      write: { add, commit, train },
      recall: {
        topSearch: recallSearch,
        itemCount: Array.isArray(recallItems.data?.atoms) ? recallItems.data.atoms.length : 0,
        relationCount: Array.isArray(recallRelations.data?.atoms) ? recallRelations.data.atoms.length : 0,
        sampleItems: Array.isArray(recallItems.data?.atoms) ? recallItems.data.atoms.slice(0, 8).map(x => x.atom) : [],
      }
    }, null, 2));
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
