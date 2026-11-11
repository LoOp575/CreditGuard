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

Use `guard.prompt.prepare` before starting a substantial task. It returns the unchanged original request, a structured execution brief, open questions, optional (unapproved) requirement suggestions, and a bounded task outline. Use `guard.failure.analyze` with prior attempts from project history before retrying a failed task. Use `guard.intent.check_scope` to compare task requirement IDs with the approved baseline, and `guard.quality.evaluate` to ensure required checks have evidence.

The preparation logic is deliberately conservative and deterministic. It structures known information; it does not pretend to infer every hidden user intention. The connected Agent remains responsible for semantic interpretation, asking the user when critical decisions are missing, and actually executing the plan. Persist compact project summaries and attempt history in checkpoints; do not store secrets or unnecessary raw private prompts.


## Approval Gate

Credit Guard exposes `guard.approval.request`, `guard.approval.get`, `guard.approval.resolve`, and `guard.approval.check`. Risky scope, architecture, destructive, production, spending-limit, and security-sensitive actions can be paused until a trusted user approval interface records a decision. Approval is time-limited and bound to the exact project and scope fingerprint. Apply migration `004_approval_gate.sql` and configure `APPROVAL_AUTHORITY_TOKEN` outside the Agent environment. The current MCP contract is fail-closed but not a universal firewall; hard enforcement still requires the Agent Orchestrator and privileged tool adapters to require the check.
