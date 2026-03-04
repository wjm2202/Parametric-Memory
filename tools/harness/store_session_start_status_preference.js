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

function toParsed(result) {
  const text = ('content' in result ? (result.content.find(i => i.type === 'text') || {}).text : '') || '';
  try {
    return { isError: !!result.isError, data: JSON.parse(text) };
  } catch {
    return { isError: !!result.isError, data: text };
  }
}

async function main() {
  const repoRoot = resolve(__dirname, '..', '..');
  const envFile = parseEnvFile(resolve(repoRoot, '.env'));
  const apiKey = process.env.MMPM_API_KEY || process.env.MMPM_MCP_API_KEY || envFile.MMPM_API_KEY || '';

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

  const client = new Client({ name: 'mmpm-session-status-pref', version: '1.0.0' });
  await client.connect(transport);

  try {
    const atoms = [
      'v1.fact.workflow.glen.require_current_sprint_status_summary_at_session_start_src_human_conf_high_scope_project_dt_2026_03_04',
      'v1.state.workflow.glen_prefers_auto_current_sprint_status_each_session_src_human_conf_high_scope_project_dt_2026_03_04',
      'v1.relation.workflow.session_start_requires_current_sprint_status_summary_src_human_conf_high_scope_project_dt_2026_03_04',
      'v1.event.workflow.preference_session_start_status_summary_confirmed_dt_2026_03_04_src_human_conf_high_scope_project'
    ];

    const add = toParsed(await client.callTool({ name: 'memory_atoms_add', arguments: { atoms } }));
    const commit = toParsed(await client.callTool({ name: 'memory_commit', arguments: {} }));

    const sequence = [
      'v1.fact.workflow.glen.step1_identify_what_we_are_working_on_src_human_conf_high_scope_project_dt_2026_03_04',
      'v1.fact.workflow.glen.require_current_sprint_status_summary_at_session_start_src_human_conf_high_scope_project_dt_2026_03_04',
      'v1.state.workflow.glen_prefers_auto_current_sprint_status_each_session_src_human_conf_high_scope_project_dt_2026_03_04'
    ];
    const train = toParsed(await client.callTool({ name: 'memory_train', arguments: { sequence } }));

    const verify = toParsed(await client.callTool({
      name: 'memory_search',
      arguments: { query: 'glen current sprint status summary session start preference', limit: 8, threshold: 0 }
    }));

    console.log(JSON.stringify({ add, commit, train, verify }, null, 2));
  } finally {
    await transport.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
