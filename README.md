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
9. Provider gateway enforcement remains the next major phase.

## Planned stack

- TypeScript + Node.js
- Official Model Context Protocol TypeScript SDK
- PostgreSQL as the durable source of truth for budgets and reservations
- Redis later for counters, loop state, and fast ephemeral coordination
- Fastify for the future provider gateway
- OpenTelemetry for observability

## Repository layout

```text
apps/
  mcp-server/       MCP interface
  gateway/          Future provider proxy/enforcement layer
  worker/           Future async reconciliation and jobs
packages/
  guard-core/       Credit, project, loop, decision, optimizer logic
  shared/           Shared types and contracts
docs/               Architecture, security, roadmap
```

## Development status

The repository now includes PostgreSQL-backed credit, project, loop, and checkpoint components; explainable decisions; a deterministic context optimizer; and a Fastify Gateway with OpenAI, Anthropic, and Google adapters. The Gateway keeps provider keys on the server, uses project-scoped tokens, applies decision/loop preflight, can switch to a configured cheaper same-provider model when safe, reserves credit before dispatch, and records usage/outcome metadata without storing prompts or secrets. MCP tools also expose active reservations and unresolved Gateway requests for manual recovery. CI applies the PostgreSQL migrations and runs core integration tests.

**Important limitation:** the MCP interface remains advisory-only. It cannot stop an Agent from calling a provider directly. Evidence verification trusts the caller's verification step and is not a cryptographic artifact verifier. In-memory mode is development-only and loses state on restart. Gateway deployment still requires operator-supplied project tokens, provider keys, and verified model pricing. Its token estimate is heuristic, and actual provider charges can exceed estimates. Representative-agent tests, load/failover testing, credential rotation, and security review remain before production claims.

## Local setup

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install

# Optional local PostgreSQL
docker compose up -d postgres
# Apply both migrations using psql or your migration runner:
# psql "$DATABASE_URL" -f database/migrations/001_credit_ledger.sql
# psql "$DATABASE_URL" -f database/migrations/002_project_loop_checkpoint.sql
# psql "$DATABASE_URL" -f database/migrations/003_gateway_audit.sql
# Then start MCP or Gateway.
pnpm --filter @credit-guard/mcp-server dev
# In another terminal, after Gateway secrets and pricing are configured:
pnpm --filter @credit-guard/gateway dev
```

Copy `.env.example` to `.env` when environment configuration is needed. Never commit API keys or provider credentials.

## Security

- Do not store provider API keys in project state or logs.
- Never claim that MCP-only mode can enforce a hard spending cap against a bypassing agent.
- Reserve budget atomically before a provider request when operating through the Gateway.
- Reconcile actual provider usage, including billable failed requests where provider data confirms a charge.
- Keep audit events free of secrets and unnecessary prompt content.

## License

License not yet selected.
