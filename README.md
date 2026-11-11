# Credit Guard

Credit Guard is a free, BYOK-first credit control and optimization layer for AI agents.

It helps agents estimate usage, reserve project budgets, detect wasteful retry loops, track verified progress, and choose safer execution strategies.

## Product principles

- **Free to use:** no subscription or mandatory token.
- **Bring your own keys:** users pay their AI providers directly.
- **No token dependency:** GUARD token, wallets, and staking are outside the MCP MVP.
- **Transparent decisions:** every decision should include a reason and measurable budget impact.
- **Enforcement is explicit:** an MCP server can advise an agent, but cannot stop direct provider calls that bypass it. Hard enforcement requires routing provider traffic through the Credit Guard Gateway.

## MVP scope

1. MCP server and typed tool contracts.
2. Project budget and credit state.
3. Preflight estimates and atomic credit reservations.
4. Usage reconciliation after provider responses.
5. Persistent project lifecycle, milestone evidence, and checkpoint state.
6. Persistent retry/loop protection and no-progress detection.
7. Decision engine: ALLOW, OPTIMIZE, INTERVENE, CHECKPOINT_PAUSE, BLOCK.
8. Context selection under a character budget.
9. Provider gateway enforcement with BYOK credential isolation.\n10. Prompt Intelligence: preserve user intent, structure prompts, surface unknowns, and plan bounded tasks.\n11. Failure and quality intelligence: avoid repeated failed strategies, check approved scope, and require evidence for required quality checks.
12. Unified execution orchestrator: combine prompt, scope, quality, loop, project, and budget signals into one advisory execution recommendation.

## Planned stack

- TypeScript + Node.js
- Official Model Context Protocol TypeScript SDK
- PostgreSQL as the durable source of truth for budgets and reservations
- Redis later for fast ephemeral counters and coordination; PostgreSQL remains authoritative for the ledger and loop history
- Fastify for the provider gateway
- OpenTelemetry for observability

## Repository layout

```text
apps/
  mcp-server/       MCP interface
  gateway/          Provider proxy and enforcement layer
  worker/           Future async reconciliation and jobs
packages/
  guard-core/       Credit, project, loop, decision, optimizer logic
  shared/           Shared types and contracts
docs/               Architecture, security, roadmap
```

## Development status

The repository now includes PostgreSQL-backed credit, project, loop, and checkpoint components; explainable decisions; a deterministic context optimizer; and a Fastify Gateway with OpenAI, Anthropic, and Google adapters. The Gateway keeps provider keys on the server, uses project-scoped tokens, applies decision/loop preflight, can switch to a configured cheaper same-provider model when safe, reserves credit before dispatch, and records usage/outcome metadata without storing prompts or secrets. MCP tools also expose active reservations and unresolved Gateway requests for manual recovery. CI applies the PostgreSQL migrations and runs core integration tests.

**Important limitation:** the MCP interface remains advisory-only. It cannot stop an Agent from calling a provider directly. Evidence verification requires a separate verifier secret, but the MCP tool does not itself inspect artifacts; a trusted verifier integration is still required. In-memory mode is development-only and loses state on restart. Gateway deployment still requires operator-supplied project tokens, provider keys, and verified model pricing. Its token estimate is heuristic, and actual provider charges can exceed estimates. Representative-agent tests, load/failover testing, automated secret-manager integration, and security review remain before production claims. Manual token/provider-key rotation procedures are documented.

## Local setup

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install

# Create local environment file (PowerShell: Copy-Item .env.example .env)
cp .env.example .env
# Start local PostgreSQL
docker compose up -d postgres
# Apply all migrations with psql:
psql "postgresql://credit_guard:local_dev_only_change_me@localhost:5432/credit_guard" -f database/migrations/001_credit_ledger.sql
psql "postgresql://credit_guard:local_dev_only_change_me@localhost:5432/credit_guard" -f database/migrations/002_project_loop_checkpoint.sql
psql "postgresql://credit_guard:local_dev_only_change_me@localhost:5432/credit_guard" -f database/migrations/003_gateway_audit.sql
psql "postgresql://credit_guard:local_dev_only_change_me@localhost:5432/credit_guard" -f database/migrations/004_approval_gate.sql

# Start MCP
pnpm --filter @credit-guard/mcp-server dev
# In another terminal, after Gateway secrets and pricing are configured:
pnpm --filter @credit-guard/gateway dev
```

Copy `.env.example` to `.env` when environment configuration is needed. Never commit API keys or provider credentials.

## Documentation

- [MCP tool reference and operating workflow](docs/MCP_TOOLS.md)
- [Gateway deployment and security configuration](apps/gateway/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Operations runbook](docs/OPERATIONS.md)
- [Roadmap](docs/ROADMAP.md)

## Security

- Do not store provider API keys in project state or logs.
- Never claim that MCP-only mode can enforce a hard spending cap against a bypassing agent.
- Reserve budget atomically before a provider request when operating through the Gateway.
- Reconcile actual provider usage, including billable failed requests where provider data confirms a charge.
- Keep audit events free of secrets and unnecessary prompt content.

## License

License not yet selected.


## Prompt and execution intelligence

Use `guard.prompt.prepare` before starting a substantial task. It returns the unchanged original request, objective, phrase-to-technical semantic interpretations, a concise `optimizedPrompt`, and `requiresSemanticReview`, alongside a structured execution brief, open questions, optional (unapproved) requirement suggestions, and a bounded task outline. Use `guard.failure.analyze` with prior attempts from project history before retrying a failed task. Use `guard.intent.check_scope` to compare task requirement IDs with the approved baseline, and `guard.quality.evaluate` to ensure required checks have evidence.

The preparation logic is deliberately conservative and deterministic. A universal intent schema covers build, debug, modify, optimize, analyze, integrate, and other software tasks. Initial language detection uses heuristics for Indonesian, English, Spanish, Portuguese, French, German, Japanese, and Chinese scripts, with a limited multilingual phrase map. This is not full translation or general-purpose semantic understanding: ambiguous or unsupported requests remain review-required, and the original prompt stays authoritative. Exact token savings require a destination-model TokenizerAdapter; generic character/word ratios are not presented as exact counts. The connected Agent remains responsible for deeper semantic interpretation, asking the user when critical decisions are missing, and actually executing the plan. Persist compact project summaries and attempt history in checkpoints; do not store secrets or unnecessary raw private prompts.


## Approval Gate

Credit Guard exposes `guard.approval.request`, `guard.approval.get`, `guard.approval.resolve`, `guard.approval.check`, and `guard.action.authorize`. The action authorization contract binds approvals to project, action class, and exact scope fingerprint, and rejects idempotency-key reuse with a different approval payload. Risky scope, architecture, destructive, production, spending-limit, and security-sensitive actions can be paused until a trusted user approval interface records a decision. Approval is time-limited and bound to the exact project and scope fingerprint. Apply migration `004_approval_gate.sql` and configure `APPROVAL_AUTHORITY_TOKEN` outside the Agent environment. The action adapter maps file overwrite/delete, production deploys, database migrations, budget changes, scope changes, architecture changes, and security changes to explicit approval classes. The current MCP contract is fail-closed but not a universal firewall; hard enforcement still requires the Agent Orchestrator and privileged tool adapters to require `guard.action.authorize` and stop dispatch unless it returns `allowed: true`.


## Unified execution orchestrator

`guard.orchestrator.evaluate` composes the existing intelligence and policy modules into a single explainable recommendation. It reads project, budget, progress, and loop state, then reports whether the Agent should block, pause, optimize cost, clarify intent, request scope approval, execute with guardrails, or verify before completion. This is advisory composition only: it does not intercept arbitrary Agent tools or provider calls, and does not replace the Gateway or trusted approval/verifier integrations. See `docs/MCP_TOOLS.md` for the input contract and enforcement boundary.


## Trusted action adapter

The guard-core package exports `executeWithGuard` and `createActionScopeFingerprint`. A trusted tool handler wraps its real dispatch function with this adapter. It computes a SHA-256 fingerprint from the action class and canonicalized payload, asks a trusted authorization callback, and invokes the handler only when the callback returns `allowed: true`.

The authorization callback must read approval state from a trusted server-side source. Never trust an Agent-supplied authorization boolean or fingerprint. Compute the fingerprint immediately before dispatch from the exact payload that will be executed. Keep the dispatch function private and do not expose an alternate unguarded route. If the authorization service errors or is unavailable, execution stops. This is a reusable reference adapter, not a global OS sandbox: it cannot intercept arbitrary third-party tools, direct shell access, or provider calls that bypass the Gateway. Every integration must wrap all relevant execution paths.


## Guarded Agent filesystem adapter

The workspace package `@credit-guard/agent-adapter` provides `GuardedFilesystemAdapter` for a bounded local workspace. Create it with a canonical workspace root, project ID, and an authorization callback that calls the trusted Credit Guard `guard.action.authorize` service. All writes, overwrites, and deletes pass through `executeWithGuard`; denied or unavailable authorization prevents the filesystem mutation. New files map to `FILE_WRITE`, existing files to `FILE_OVERWRITE`, and removals to `FILE_DELETE`. Read operations reject symlink targets and use no-follow file opens.

Example integration outline:

```ts
import { GuardedFilesystemAdapter } from "@credit-guard/agent-adapter";

// authorize must call the trusted MCP/server-side policy endpoint.
// It must return the parsed authorization response, not an Agent assertion.
const files = await GuardedFilesystemAdapter.create({
  rootDirectory: "/workspace/project",
  projectId: "project-123",
  authorize: async (request) => trustedPolicyClient.authorize(request),
});

await files.write("src/example.ts", "export const ready = true;");
```

This adapter is a reference integration for one filesystem boundary, not a complete operating-system sandbox. It does not control shell commands, database clients, deployment tools, other processes, or provider traffic. Keep the authorization credential outside the Agent, do not expose unguarded filesystem handles to the Agent, and use an OS/container sandbox against hostile concurrent local processes. Run CI before relying on a deployment.


## Guarded Agent adapters

The workspace package `@credit-guard/agent-adapter` now includes:

- `GuardedFilesystemAdapter`: bounded workspace reads/writes/overwrites/deletes; destructive operations require exact-scope approval.
- `GuardedTerminalAdapter`: executes only trusted executable profiles, never a caller-supplied executable path; uses `shell: false`, a bounded timeout/output buffer, and requires security-sensitive approval for every command.
- `GuardedDatabaseAdapter`: Agent selects a trusted migration ID only. SQL is registered by the host, SHA-256 checked, executed in a transaction, serialized with an advisory lock, and recorded in `cg_agent_migrations`. Database migrations require production approval.
- `GuardedDeploymentAdapter`: Agent selects a trusted deployment target and artifact reference; a host-registered deployment handler runs only after production approval.
- `createPostgresActionAuthorizer`: reads `cg_approval_requests` directly and verifies approval status, expiry, project, approval class, and exact fingerprint. Database errors propagate and fail closed.

Example trusted wiring:

```ts
import { Pool } from "pg";
import {
  createPostgresActionAuthorizer,
  GuardedFilesystemAdapter,
  GuardedTerminalAdapter,
} from "@credit-guard/agent-adapter";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const authorize = createPostgresActionAuthorizer(pool);

const files = await GuardedFilesystemAdapter.create({
  rootDirectory: "/workspace/project",
  projectId: "project-123",
  authorize,
});

const terminal = await GuardedTerminalAdapter.create({
  rootDirectory: "/workspace/project",
  projectId: "project-123",
  authorize,
  commands: { node: process.execPath },
});
```

Keep the PostgreSQL connection and approval authority outside Agent context. The Agent must never receive a raw database pool, provider keys, deployment credentials, or an unguarded alternative tool. Terminal executable profiles are trusted host configuration; approval is bound to the exact profile, executable, arguments, and workspace. Database migration SQL and deployment handlers are trusted host configuration, not Agent-submitted code.

These adapters are enforcement boundaries only when every corresponding Agent tool is routed through them. They do not sandbox arbitrary child processes, third-party plugins, direct host access, or network calls. Run them in a least-privilege OS/container workspace with restricted network and filesystem permissions. Deployment integrations must register their actual provider-specific handler; the generic adapter does not pretend to deploy by itself.
