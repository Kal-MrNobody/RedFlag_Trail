#!/usr/bin/env node
/**
 * OpenAPI -> MCP shim: the CONTROL SURFACE for the Bazantic A/B test.
 *
 * A Bazantic gateway takes an OpenAPI spec and generates one callable tool per
 * operation, naming and describing each from the spec alone. This shim does the
 * same thing locally so both arms of the A/B run against IDENTICAL tools.
 *
 * The rule this file exists to enforce: NOTHING here is hand-written guidance.
 * Every tool name, description and parameter is read out of api/openapi.json.
 * If it were otherwise, the A/B would be comparing two prompts, not measuring a
 * Recipe.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';

const SPEC = JSON.parse(readFileSync(new URL('../../api/openapi.json', import.meta.url), 'utf8'));
const BASE = process.env.RFT_API_BASE ?? 'http://localhost:8791';

const zodFor = (schema = {}) =>
  schema.type === 'integer' || schema.type === 'number' ? z.number() : z.string();

/** Resolve a local $ref so the response shape reaches the agent, exactly as a
 *  gateway that inlines component schemas into its tool docs would. */
function deref(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) {
    if (seen.has(node.$ref)) return { note: 'recursive ref omitted' };
    const path = node.$ref.replace(/^#\//, '').split('/');
    return deref(path.reduce((o, k) => o?.[k], SPEC), new Set([...seen, node.$ref]));
  }
  if (Array.isArray(node)) return node.map((n) => deref(n, seen));
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, seen)]));
}

const server = new McpServer({ name: 'redflag-trail-openapi', version: SPEC.info.version });
const registered = [];

for (const [path, methods] of Object.entries(SPEC.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (!op.operationId) continue;

    const params = op.parameters ?? [];
    const shape = Object.fromEntries(params.map((p) => {
      const t = zodFor(p.schema).describe(p.description ?? '');
      return [p.name, p.required ? t : t.optional()];
    }));

    // Description = spec summary + spec description + the response schema the
    // spec declares. Verbatim; no additions.
    const okSchema = deref(op.responses?.['200']?.content?.['application/json']?.schema);
    const description = [
      op.summary,
      op.description,
      okSchema ? `Returns: ${JSON.stringify(okSchema)}` : null,
    ].filter(Boolean).join('\n\n');

    server.registerTool(op.operationId, { title: op.summary, description, inputSchema: shape },
      async (args = {}) => {
        let url = path;
        const query = new URLSearchParams();
        for (const p of params) {
          const v = args[p.name];
          if (v === undefined) continue;
          if (p.in === 'path') url = url.replace(`{${p.name}}`, encodeURIComponent(String(v)));
          else query.set(p.name, String(v));
        }
        const target = `${BASE}${url}${query.size ? `?${query}` : ''}`;
        try {
          const res = await fetch(target, { method: method.toUpperCase() });
          const body = await res.text();
          return { content: [{ type: 'text', text: `HTTP ${res.status}\n${body}` }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `request failed: ${err.message}` }] };
        }
      });
    registered.push(`${method.toUpperCase()} ${path} -> ${op.operationId}`);
  }
}

process.stderr.write(`openapi-mcp-shim: ${registered.length} tools\n${registered.join('\n')}\n`);
await server.connect(new StdioServerTransport());
