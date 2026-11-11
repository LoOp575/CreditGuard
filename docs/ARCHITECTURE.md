# Credit Guard Architecture

## Request path

Advisory MCP mode:

`Agent -> Credit Guard MCP tools -> recommendation -> Agent`

Enforced Gateway mode (planned next phase):

`Agent -> project-scoped Gateway token -> Fastify Gateway -> policy + PostgreSQL reservation -> provider adapter -> AI provider`

MCP is a protocol interface, not a network firewall. An agent that retains direct provider access can bypass advisory checks. A hard budget boundary is only possible when provider traffic is routed through the Gateway, provider keys remain only on the Gateway host, project-scoped Gateway tokens are used, and any old direct provider credentials available to the Agent are revoked.

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

Progress must be supported by observable evidence such as test results, file changes, generated artifacts, or completed milestones. Evidence is recorded as unverified first. A trusted operator or integration must verify it before a milestone completes. The current MCP verification tool trusts its caller and does not independently inspect artifacts.

## Persistence implementation status

Money is represented as integer USD micros (1 USD = 1,000,000 micros). `PostgresCreditLedger` stores budgets and reservations transactionally, locks the project row during reservation, and enforces unique `(project_id, idempotency_key)` keys. `PostgresProjectStore` persists project lifecycle, milestones, and evidence. `PostgresLoopStore` persists retry/error/progress events. `PostgresCheckpointStore` saves versioned resume payloads. The MCP server selects these PostgreSQL adapters when `DATABASE_URL` is configured and verifies both migrations at startup. Without a database URL, it uses explicitly reported in-memory development adapters.

CI applies both migrations to PostgreSQL 16 and runs integration tests for concurrent reservation, settlement, project evidence, loop detection, and checkpoint retrieval. This automated coverage does not replace production load testing, crash/failover testing, threat modeling, or security review. Redis is not the authoritative credit ledger.

## Gateway enforcement

The Gateway accepts an OpenAI-shaped text-message request envelope and routes to fixed OpenAI, Anthropic, or Google endpoints. Provider keys are loaded from server-side secret configuration keyed by provider and project; they are never accepted from Agent request headers. Project-scoped tokens authorize the request. Model pricing must be explicitly configured and missing rates fail closed. Before dispatch, the Gateway reserves a conservative estimated cost. After dispatch, provider-reported usage is reconciled and metadata-only audit rows record provider, model, token counts, costs, and outcome. Prompt bodies and credentials are not stored in the audit table.

Input-token estimation is heuristic, not tokenizer-exact. A configured safety multiplier reduces underestimation risk but does not guarantee a hard cap on final provider billing. Unknown outcomes keep the reservation held for manual reconciliation. The Gateway returns provider-native response data in an envelope, not a byte-for-byte OpenAI-compatible response.

## Budget safety

A future Gateway reservation must be atomic. Concurrent requests must not both spend the same remaining balance. After provider completion, reconcile the reservation against actual usage. A failed HTTP request is not automatically free; provider billing records determine whether a charge occurred.

## Decision semantics

- ALLOW: proceed within policy.
- OPTIMIZE: adjust model, context, or output budget before proceeding.
- INTERVENE: ask the agent/user to change execution strategy.
- CHECKPOINT_PAUSE: persist state and pause safely.
- BLOCK: deny a request that violates a hard policy.

Every decision should return a machine-readable reason and relevant budget/progress metrics.
