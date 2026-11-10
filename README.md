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
- PostgreSQL for durable project and audit data
- Redis for counters, reservations, and fast state
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

This repository starts with the MCP foundation. Features are added incrementally and must be tested before being described as production-ready.

## Local setup

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
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
