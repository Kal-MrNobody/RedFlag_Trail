// Agent0 / ERC-8004 registry client.
//
// Every field below is taken from the subgraph's published schema.graphql
// (agent0lab/subgraph). Confirmed entities: Agent (agentWallet, owner,
// totalFeedback, lastActivity, registrationFile, feedback, validations),
// AgentRegistrationFile (name, ens, x402Support, active), Feedback (value,
// isRevoked), Validation (response, status).

export const AGENT0_BASE_SUBGRAPH = '43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb';

export function gatewayUrl(subgraphId = AGENT0_BASE_SUBGRAPH) {
  const key = process.env.GRAPH_API_KEY;
  if (!key) {
    throw new Error(
      'GRAPH_API_KEY not set. The Agent0 registry is queried through The Graph gateway,\n' +
      'which needs a Subgraph Studio key. NOTE: the Graph MARKET key (server_...) used for\n' +
      'Substreams does NOT work here - the gateway rejects it as "malformed API key".\n' +
      'Get one at https://thegraph.com/studio -> API Keys.',
    );
  }
  return `https://gateway.thegraph.com/api/${key}/subgraphs/id/${subgraphId}`;
}

export async function query(gql, variables = {}) {
  const res = await fetch(gatewayUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables }),
  });
  // A gateway 402/429/502 returns HTML, so res.json() would throw an opaque
  // SyntaxError and hide the status - the one thing that says what to do next.
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(
      `Agent0 subgraph gateway returned ${res.status} ${res.statusText}.\n` +
      (res.status === 401 || res.status === 403
        ? 'Check GRAPH_API_KEY - the Graph MARKET key (server_...) is rejected here; '
        + 'this needs a Subgraph Studio key.\n'
        : res.status === 402 ? 'Payment required: the key is out of free-tier query budget.\n'
        : res.status === 429 ? 'Rate limited; retry with a smaller batch.\n' : '') +
      `body: ${body}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Agent0 subgraph: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/** Look up agents by their on-chain wallet address. Addresses must be
 *  lowercased - the subgraph stores Bytes lowercased and an exact match fails
 *  otherwise. */
export async function lookupByWallets(addresses) {
  const wallets = addresses.map((a) => a.toLowerCase());
  const data = await query(
    `query($wallets: [Bytes!]) {
       agents(where: { agentWallet_in: $wallets }, first: 1000) {
         id
         agentId
         chainId
         agentWallet
         owner
         totalFeedback
         lastActivity
         createdAt
         registrationFile { name ens x402Support active description }
         feedback(first: 100) { value isRevoked }
         validations(first: 50) { response status }
       }
     }`,
    { wallets },
  );
  const byWallet = new Map();
  for (const a of data.agents ?? []) {
    if (a.agentWallet) byWallet.set(a.agentWallet.toLowerCase(), a);
  }
  return byWallet;
}

/** Reduce an agent record to the fields the risk rules actually consume. */
export function summarise(agent) {
  if (!agent) return { registered: false };
  // The query pages feedback at `first: 100`, so this is the mean over the most
  // recent 100 entries, NOT over total_feedback. Reported alongside the sample
  // size so the two are never read as the same population.
  const live = (agent.feedback ?? []).filter((f) => !f.isRevoked);
  const avg = live.length
    ? live.reduce((s, f) => s + Number(f.value), 0) / live.length
    : null;
  const completed = (agent.validations ?? []).filter((v) => v.status === 'COMPLETED');
  return {
    registered: true,
    agent_id: agent.id,
    name: agent.registrationFile?.name ?? null,
    ens: agent.registrationFile?.ens ?? null,
    x402_support: agent.registrationFile?.x402Support ?? null,
    active: agent.registrationFile?.active ?? null,
    total_feedback: Number(agent.totalFeedback ?? 0),
    avg_feedback: avg,
    avg_feedback_sample: live.length,   // the mean covers this many, not total_feedback
    validations_completed: completed.length,
    created_at: agent.createdAt ? Number(agent.createdAt) : null,
  };
}
