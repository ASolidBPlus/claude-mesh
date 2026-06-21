import { openDb, registerAgent, getAgentById } from './db.ts';
import { generateToken, hashToken } from './auth.ts';

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand !== 'register') {
  process.stderr.write('usage: cli.ts register <agent-id> <hostname>\n');
  process.exit(1);
}

const agentId = args[1];
const hostname = args[2];

if (!agentId || !hostname) {
  process.stderr.write('usage: cli.ts register <agent-id> <hostname>\n');
  process.exit(1);
}

const dbPath = process.env.MESH_DB_PATH ?? '/data/mesh.db';
const db = openDb(dbPath);

const existing = getAgentById(db, agentId);
if (existing !== null) {
  process.stderr.write(`error: agent '${agentId}' already exists\n`);
  process.exit(1);
}

const rawToken = generateToken();
const hash = hashToken(rawToken);

registerAgent(db, { id: agentId, token_hash: hash, hostname });

process.stdout.write(
  `registered agent '${agentId}'\n` +
  `token: ${rawToken}\n` +
  `\n` +
  `Store this token securely — it will not be shown again.\n` +
  `Set these in your client environment:\n` +
  `  MESH_AGENT_ID=${agentId}\n` +
  `  MESH_AGENT_TOKEN=${rawToken}\n` +
  `  MESH_SERVER_URL=ws://localhost:7384\n`
);
process.exit(0);
