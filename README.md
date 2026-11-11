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
5. Retry/loop protection.
6. Project progress and checkpoint state.
7. Decision engine: ALLOW, OPTIMIZE, INTERVENE, CHECKPOINT_PAUSE, BLOCK.
8. Provider gateway in a later phase.

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

The repository now includes an MCP foundation, an in-memory reference engine, and an initial PostgreSQL ledger adapter:
- Project budget creation and status
- Preflight checks
- Durable reservations with per-project row locking and idempotency constraints
- Actual-usage settlement and unused-reservation release
- A PostgreSQL migration and optional DATABASE_URL-based MCP selection
- In-memory unit tests for concurrency, idempotency, budget overruns, and release behavior

**Important limitation:** the PostgreSQL adapter and migration have been committed but have not yet been compiled or integration-tested against a live PostgreSQL instance. Without DATABASE_URL, MCP explicitly uses the non-durable in-memory development ledger. Apply the migration before starting with DATABASE_URL. Do not treat this as production-ready until database integration, multi-instance concurrency, crash-recovery, and security tests pass.

## Local setup

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install

# Optional local PostgreSQL
docker compose up -d postgres
# Apply database/migrations/001_credit_ledger.sql using psql or your migration runner.
# Then set DATABASE_URL in .env and start MCP.
pnpm --filter @credit-guard/mcp-server dev
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
