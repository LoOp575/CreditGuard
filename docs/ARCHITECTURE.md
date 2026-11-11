# Credit Guard Architecture

## Request path

Advisory MCP mode:

`Agent -> Credit Guard MCP tools -> recommendation -> Agent`

Enforced Gateway mode:

`Agent -> project-scoped Gateway token -> Fastify Gateway -> policy + PostgreSQL reservation -> provider adapter -> AI provider`

MCP is a protocol interface, not a network firewall. An agent that retains direct provider access can bypass advisory checks. A hard budget boundary is only possible when provider traffic is routed through the Gateway, provider keys remain only on the Gateway host, project-scoped Gateway tokens are used, and any old direct provider credentials available to the Agent are revoked.

## Core domains

- **Credit Engine:** budgets, estimates, reservations, usage reconciliation.
- **Project Engine:** project lifecycle, milestones, verified artifacts, checkpoints.
- **Loop Guard:** repeated errors, retries, lack of progress, and bounded execution.
- **Decision Engine:** ALLOW, OPTIMIZE, INTERVENE, CHECKPOINT_PAUSE, BLOCK.
- **Context Optimizer:** deterministic context-section selection under a character budget.
- **Provider Adapters:** normalized provider requests and usage records.
- **Audit:** explainable decisions without logging secrets.

## Initial project states

CREATED, PLANNING, EXECUTING, VERIFYING, COMPLETED, PAUSED, BLOCKED, FAILED.

Progress must be supported by observable evidence such as test results, file changes, generated artifacts, or completed milestones. Evidence is recorded as unverified first. A separate `EVIDENCE_VERIFIER_TOKEN` is required to mark it verified, and that secret must remain outside the Agent's context. The MCP tool does not independently inspect artifacts; a trusted verifier integration must check CI runs, artifact hashes, repository diffs, or other authoritative sources.

## Persistence implementation status

Money is represented as integer USD micros (1 USD = 1,000,000 micros). `PostgresCreditLedger` stores budgets and reservations transactionally, locks the project row during reservation, and enforces unique `(project_id, idempotency_key)` keys. `PostgresProjectStore` persists project lifecycle, milestones, and evidence. `PostgresLoopStore` persists retry/error/progress events. `PostgresCheckpointStore` saves versioned resume payloads. The MCP server selects these PostgreSQL adapters when `DATABASE_URL` is configured and verifies the required migrations at startup. Without a database URL, it uses explicitly reported in-memory development adapters.

CI applies the PostgreSQL migrations to PostgreSQL 16 and runs integration tests for concurrent reservation, settlement, project evidence, loop detection, and checkpoint retrieval. This automated coverage does not replace production load testing, crash/failover testing, threat modeling, or security review. Redis is not the authoritative credit ledger.

## Gateway enforcement

The Gateway accepts an OpenAI-shaped text-message request envelope and routes to fixed OpenAI, Anthropic, or Google endpoints. Provider keys are loaded from server-side secret configuration keyed by provider and project; they are never accepted from Agent request headers. Project-scoped tokens authorize the request. Model pricing must be explicitly configured and missing rates fail closed. Before dispatch, the Gateway reserves a conservative estimated cost. After dispatch, provider-reported usage is reconciled and metadata-only audit rows record provider, model, token counts, costs, and outcome. Prompt bodies and credentials are not stored in the audit table.

Input-token estimation is heuristic, not tokenizer-exact. A configured safety multiplier reduces underestimation risk but does not guarantee a hard cap on final provider billing. Unknown outcomes keep the reservation held for manual reconciliation. The Gateway returns provider-native response data in an envelope, not a byte-for-byte OpenAI-compatible response.

## Budget safety

The Gateway reserves estimated cost atomically before dispatch. Concurrent requests cannot reserve beyond the same project's available budget. After provider completion, provider-reported usage is reconciled against the reservation. A failed HTTP request is not automatically free; provider billing records determine whether a charge occurred. Requests require project-scoped idempotency keys, and duplicate keys never redispatch the provider.

## Decision semantics

- ALLOW: proceed within policy.
- OPTIMIZE: adjust model, context, or output budget before proceeding.
- INTERVENE: ask the agent/user to change execution strategy.
- CHECKPOINT_PAUSE: persist state and pause safely.
- BLOCK: deny a request that violates a hard policy.

Every decision should return a machine-readable reason and relevant budget/progress metrics.


## Prompt and execution intelligence

The Intelligence layer prepares a structured execution brief from the original user prompt before an Agent starts work. It preserves the original request, separates explicit constraints from unknowns, marks domain-specific ideas as suggestions rather than approved scope, and proposes bounded tasks with observable completion evidence. The deterministic pre-processor is intentionally conservative; it does not claim to replace an LLM's semantic reasoning or silently answer critical unknowns.

The MCP tools expose:
- `guard.prompt.prepare`: create the prompt brief, clarification questions, suggested requirements, and task outline.
- `guard.failure.analyze`: compare a new error/strategy pair with prior attempts and recommend diagnosis, replanning, or pause. The Agent must persist and supply prior attempts through project history/checkpoints.
- `guard.intent.check_scope`: compare task requirement IDs against the approved requirement baseline. This is an ID-based guardrail, not a semantic classifier.
- `guard.quality.evaluate`: evaluate explicit checks; required checks need passing results and evidence references.

These tools complement the existing Loop Guard, Context Optimizer, Project Engine, Decision Engine, Credit Engine, and Gateway. They do not independently observe an Agent's filesystem or force an external Agent to call them. Reliable enforcement requires Agent integration and, for provider spend control, routing model traffic through the Gateway.
