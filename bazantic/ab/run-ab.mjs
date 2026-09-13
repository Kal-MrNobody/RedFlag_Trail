#!/usr/bin/env node
/**
 * Bazantic Recipe A/B harness.
 *
 * One question, one model, one set of tools, run twice. The ONLY difference
 * between the two arms is the published Recipe:
 *
 *   A (control)  system prompt = neutral base            user = the raw question
 *   B (recipe)   system prompt = neutral base + recipe.description
 *                user = recipe.prompt_template with {{inputs}} filled
 *
 * Tools in both arms come from bazantic/ab/openapi-mcp-shim.mjs, which generates
 * them from api/openapi.json alone - the same input the Bazantic gateway takes.
 * Both arms therefore see identical tool names, descriptions and schemas, and
 * both hit the same live Postgres through the same API. Every built-in tool is
 * denied, so neither arm can read this repository and shortcut the task.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(HERE, 'runs');
const MODEL = process.env.AB_MODEL ?? 'claude-opus-5';
const API_BASE = process.env.RFT_API_BASE ?? 'http://localhost:8791';

const recipe = JSON.parse(readFileSync(resolve(ROOT, 'bazantic/recipe.json'), 'utf8'));

const QUESTION =
  'We run a fleet of AI agents that pay for services with x402. Over the last 30 days: '
  + 'what did the fleet spend, which vendors are risky, and should we block any of them? '
  + 'Give me a decision I can act on.';
const INPUTS = { question: QUESTION, since_days: 30 };

/** Identical in both arms. Establishes the role only - it carries none of the
 *  domain knowledge the Recipe is being measured on. */
const BASE_SYSTEM =
  'You are an autonomous analyst agent. You have been given a set of tools that call a '
  + 'live HTTP API. Use them to answer the request, then write your final answer as plain '
  + 'prose for a human decision-maker. You cannot ask follow-up questions; answer with what '
  + 'the tools give you.';

/** Everything the arms must NOT have. Either arm reaching a file, the network
 *  or a sub-agent could reach this repository's own notes and answer from them
 *  instead of from the API, which would measure nothing. */
const DENIED = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'Agent', 'ToolSearch', 'Monitor', 'Artifact',
  'TaskCreate', 'TaskUpdate', 'TaskOutput', 'TaskList', 'TaskGet', 'TaskStop',
  'SendUserFile', 'AskUserQuestion', 'Skill', 'SlashCommand', 'ListMcpResourcesTool',
  'ReadMcpResourceTool', 'KillShell', 'BashOutput', 'TodoWrite',
];

const TOOLS = ['getSpendSummary', 'getVendorRisk', 'listFindings', 'backtestFinding', 'health']
  .map((t) => `mcp__rft__${t}`);

const mcpConfig = JSON.stringify({
  mcpServers: {
    rft: {
      command: 'node',
      args: [resolve(HERE, 'openapi-mcp-shim.mjs')],
      env: { RFT_API_BASE: API_BASE },
    },
  },
});

const ARMS = {
  A: {
    label: 'control - gateway tools only, no Recipe',
    system: BASE_SYSTEM,
    append: null,
    user: QUESTION,
  },
  B: {
    label: 'treatment - same tools, published Recipe applied',
    system: BASE_SYSTEM,
    append: recipe.description,
    user: recipe.prompt_template.replace('{{inputs}}', JSON.stringify(INPUTS, null, 2)),
  },
};

function runArm(name, arm) {
  const args = [
    '-p', arm.user,
    '--model', MODEL,
    '--system-prompt', arm.system,
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', ...TOOLS,
    '--disallowedTools', ...DENIED,
    '--output-format', 'stream-json', '--verbose',
  ];
  if (arm.append) args.splice(6, 0, '--append-system-prompt', arm.append);

  return new Promise((ok, fail) => {
    // cwd is an empty directory OUTSIDE the repository. CLAUDE.md discovery
    // walks up the tree, so running anywhere under the repo would hand both arms
    // this project's own working agreement and rules of engagement - context a
    // real caller of the published API would never have.
    const sandbox = mkdtempSync(resolve(tmpdir(), `rft-ab-${name}-`));
    const child = spawn('claude', args, { cwd: sandbox, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', fail);
    child.on('close', (code) => ok({ code, out, err }));
  });
}

function parse(stdout) {
  const events = stdout.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const calls = [];
  let answer = '', turns = 0, cost = null;
  for (const e of events) {
    if (e.type === 'assistant') {
      turns++;
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use') calls.push({ tool: c.name, input: c.input });
        if (c.type === 'text' && c.text.trim()) answer = c.text;
      }
    }
    if (e.type === 'result') {
      if (e.result) answer = e.result;
      cost = { turns: e.num_turns, duration_ms: e.duration_ms, usd: e.total_cost_usd };
    }
  }
  return { events: events.length, turns, calls, answer, cost };
}

mkdirSync(OUT, { recursive: true });

// Re-runnable per arm: `AB_ONLY=B` runs just that arm and merges into the
// existing results.json, so a rate-limited arm can be retried without discarding
// a good run of the other.
const only = process.env.AB_ONLY ? process.env.AB_ONLY.split(',') : null;
const resultsPath = resolve(OUT, 'results.json');
let existing = {};
try { existing = JSON.parse(readFileSync(resultsPath, 'utf8')); } catch { /* first run */ }
const results = { ...(existing.arms ?? {}) };

for (const [name, arm] of Object.entries(ARMS)) {
  if (only && !only.includes(name)) continue;
  process.stderr.write(`\n=== arm ${name}: ${arm.label} ===\n`);
  const { code, out, err } = await runArm(name, arm);
  writeFileSync(resolve(OUT, `arm-${name}.stream.jsonl`), out);
  if (err.trim()) writeFileSync(resolve(OUT, `arm-${name}.stderr.log`), err);
  const parsed = parse(out);
  results[name] = { label: arm.label, exit: code, prompt: arm.user, system_append: arm.append, ...parsed };
  process.stderr.write(`exit=${code} tools=${parsed.calls.length} answer=${parsed.answer.length}b\n`);
}

writeFileSync(resolve(OUT, 'results.json'), JSON.stringify({
  model: MODEL, question: QUESTION, inputs: INPUTS, base_system: BASE_SYSTEM,
  recipe: { name: recipe.name, model: recipe.model, tool_bindings: recipe.tool_bindings },
  arms: results,
}, null, 2));
process.stderr.write(`\nwrote ${resolve(OUT, 'results.json')}\n`);
