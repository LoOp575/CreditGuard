# Credit Guard Architecture

## Request path

Advisory MCP mode:

`Agent -> Credit Guard MCP tools -> recommendation -> Agent`

Enforced Gateway mode (later phase):

`Agent -> Credit Guard Gateway -> policy + atomic reservation -> provider adapter -> AI provider`

MCP is a protocol interface, not a network firewall. An agent that retains direct provider access can bypass advisory checks. A hard budget boundary is only possible when provider traffic is routed through the Gateway and direct credentials are appropriately controlled.

## Core domains

- **Credit Engine:** budgets, estimates, reservations, usage reconciliation.
- **Project Engine:** project lifecycle, milestones, verified artifacts, checkpoints.
- **Loop Guard:** repeated errors, retries, lack of progress, and bounded execution.
- **Decision Engine:** ALLOW, OPTIMIZE, INTERVENE, CHECKPOINT_PAUSE, BLOCK.
- **Context Optimizer:** safe context reduction and output limits.
- **Provider Adapters:** normalized provider requests and usage records.
- **Audit:** explainable decisions without logging secrets.

## Initial project states

CREATED, PLANNING, EXECUTING, VERIFYING, COMPLETED, PAUSED, BLOCKED, FAILED.

Progress must be supported by observable evidence such as test results, file changes, generated artifacts, or completed milestones. An agent's self-reported percentage is not sufficient evidence by itself.

## Credit Engine implementation status

Money is represented as integer USD micros (1 USD = 1,000,000 micros). `CreditEngine` remains the in-memory reference adapter for unit tests. `PostgresCreditLedger` is the durable adapter: it stores projects and reservations in PostgreSQL, locks the project row during reservation, enforces a unique `(project_id, idempotency_key)` constraint, and commits settlement and reservation state changes in one transaction. The MCP server selects PostgreSQL when `DATABASE_URL` is set and verifies that the migration tables exist at startup; otherwise it reports the in-memory development mode.

The adapter is an initial implementation, not yet production-validated. Integration tests against PostgreSQL, concurrent multi-process tests, crash-recovery tests, and security review remain required. Redis is not the authoritative credit ledger.

## Budget safety

A future Gateway reservation must be atomic. Concurrent requests must not both spend the same remaining balance. After provider completion, reconcile the reservation against actual usage. A failed HTTP request is not automatically free; provider billing records determine whether a charge occurred.

## Decision semantics

- ALLOW: proceed within policy.
- OPTIMIZE: adjust model, context, or output budget before proceeding.
- INTERVENE: ask the agent/user to change execution strategy.
- CHECKPOINT_PAUSE: persist state and pause safely.
- BLOCK: deny a request that violates a hard policy.

Every decision should return a machine-readable reason and relevant budget/progress metrics.
