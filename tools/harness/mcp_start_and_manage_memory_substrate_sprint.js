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

function asJson(result) {
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

  const client = new Client({ name: 'mmpm-sprint-memory-manager', version: '1.0.0' });
  await client.connect(transport);

  try {
    const workflowFacts = asJson(await client.callTool({
      name: 'memory_atoms_list',
      arguments: { type: 'fact', prefix: 'v1.fact.workflow.glen', limit: 50, offset: 0 }
    }));

    const workingStyleSearch = asJson(await client.callTool({
      name: 'memory_search',
      arguments: { query: 'glen workflow sprint status session start', limit: 10, threshold: 0 }
    }));

    const atoms = [
      'v1.fact.sprint.memory_substrate.objective_enable_ai_native_memory_readiness_src_human_conf_high_scope_sprint_dt_2026_03_04',
      'v1.state.sprint.memory_substrate.status_active_src_human_conf_high_scope_sprint_dt_2026_03_04',

      'v1.fact.sprint.ms.a1_single_call_session_bootstrap_priority_p0_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.a2_namespace_isolation_priority_p0_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.b1_contradiction_aware_fact_handling_priority_p0_size_l_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.c1_time_version_query_support_priority_p0_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',

      'v1.fact.sprint.ms.b2_confidence_lifecycle_decay_reinforcement_priority_p1_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.c2_decision_evidence_bundles_priority_p1_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.d1_memory_write_policy_tiers_priority_p1_size_s_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.d2_retrieval_evidence_threshold_gating_priority_p1_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',

      'v1.fact.sprint.ms.e1_ai_facing_latency_slo_profile_priority_p2_size_s_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.e2_domain_pilot_pack_priority_p2_size_l_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',

      'v1.relation.sprint.ms.wave1_includes_a1_a2_b1_c1_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.relation.sprint.ms.wave2_includes_b2_c2_d1_d2_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.relation.sprint.ms.wave3_includes_e1_e2_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.relation.sprint.ms.requires_tests_then_full_suite_then_docs_then_metrics_src_human_conf_high_scope_sprint_dt_2026_03_04',

      'v1.event.sprint.memory_substrate.plan_initialized_via_mcp_dt_2026_03_04_src_agent_conf_high_scope_sprint'
    ];

    const add = asJson(await client.callTool({ name: 'memory_atoms_add', arguments: { atoms } }));
    const commit = asJson(await client.callTool({ name: 'memory_commit', arguments: {} }));

    const seq = [
      'v1.fact.sprint.ms.a1_single_call_session_bootstrap_priority_p0_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.a2_namespace_isolation_priority_p0_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.b1_contradiction_aware_fact_handling_priority_p0_size_l_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.c1_time_version_query_support_priority_p0_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.b2_confidence_lifecycle_decay_reinforcement_priority_p1_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.c2_decision_evidence_bundles_priority_p1_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.d1_memory_write_policy_tiers_priority_p1_size_s_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.d2_retrieval_evidence_threshold_gating_priority_p1_size_m_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.e1_ai_facing_latency_slo_profile_priority_p2_size_s_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04',
      'v1.fact.sprint.ms.e2_domain_pilot_pack_priority_p2_size_l_status_todo_src_plan_conf_high_scope_sprint_dt_2026_03_04'
    ];
    const train = asJson(await client.callTool({ name: 'memory_train', arguments: { sequence: seq } }));

    const sprintSearch = asJson(await client.callTool({
      name: 'memory_search',
      arguments: { query: 'memory substrate sprint status wave1 wave2 wave3', limit: 12, threshold: 0 }
    }));

    const sprintList = asJson(await client.callTool({
      name: 'memory_atoms_list',
      arguments: { type: 'fact', prefix: 'v1.fact.sprint.ms.', limit: 50, offset: 0 }
    }));

    const context = asJson(await client.callTool({ name: 'memory_context', arguments: { maxTokens: 900 } }));

    console.log(JSON.stringify({
      workflowFacts,
      workingStyleSearch,
      write: { add, commit, train },
      sprintCheck: {
        sprintSearch,
        sprintFactCount: Array.isArray(sprintList.data?.atoms) ? sprintList.data.atoms.length : 0,
        sprintSample: Array.isArray(sprintList.data?.atoms) ? sprintList.data.atoms.slice(0, 10).map(x => x.atom) : [],
        contextMode: context.data?.mode,
        contextTokens: context.data?.estimatedTokens
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
