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

The Intelligence layer prepares a structured execution brief from the original user prompt before an Agent starts work. It preserves the original request, separates explicit constraints from unknowns, marks domain-specific ideas as suggestions rather than approved scope, and proposes bounded tasks with observable completion evidence. The deterministic pre-processor is intentionally conservative. It maps a bounded Indonesian phrase dictionary (for example, “enak dipandang” to visual hierarchy and consistent styling, and “menyesuaikan layar” to responsive design), extracts supported project facts, and returns a concise `optimizedPrompt`. It preserves `originalPrompt` as the source of truth and sets `requiresSemanticReview` when the supported rules cannot safely represent the request. This v1 does not claim general-purpose LLM-level semantic understanding or silently answer critical unknowns.

The MCP tools expose:
- `guard.prompt.prepare`: create the prompt brief, clarification questions, suggested requirements, and task outline.
- `guard.failure.analyze`: compare a new error/strategy pair with prior attempts and recommend diagnosis, replanning, or pause. The Agent must persist and supply prior attempts through project history/checkpoints.
- `guard.intent.check_scope`: compare task requirement IDs against the approved requirement baseline. This is an ID-based guardrail, not a semantic classifier.
- `guard.quality.evaluate`: evaluate explicit checks; required checks need passing results and evidence references.

These tools complement the existing Loop Guard, Context Optimizer, Project Engine, Decision Engine, Credit Engine, and Gateway. They do not independently observe an Agent's filesystem or force an external Agent to call them. Reliable enforcement requires Agent integration and, for provider spend control, routing model traffic through the Gateway.


## Approval Gate

The Approval Gate records explicit decisions for scope, architecture, destructive, production, spending-limit, and security-sensitive actions. Requests are idempotent and expire; approvals bind to a project and exact scope fingerprint. The PostgreSQL ledger is authoritative when configured. Resolution requires `APPROVAL_AUTHORITY_TOKEN`, which belongs only to a trusted human approval interface/operator and must never enter Agent context. The check is fail-closed for missing, pending, rejected, expired, or mismatched approvals.

The MCP implementation exposes the request/get/resolve/check contract. It is not yet a universal action firewall: a model-controlled Agent can ignore a check or use an unmediated tool. Hard enforcement requires the Agent Integration Orchestrator to gate every privileged tool adapter and keep approval authority outside the model's reach. The Gateway currently does not intercept arbitrary non-provider actions.


## Universal Intent Engine

Prompt preparation uses a task-agnostic intent schema so the system is not limited to website creation. The schema captures task type (build, debug, modify, optimize, analyze, integrate, or other), target, objective, requirements, explicit constraints, available project context, expected output, and verification approach. Deterministic phrase rules provide a conservative first-pass classification; they are not multilingual or general-purpose semantic understanding. Unsupported or ambiguous intent must retain the original prompt and be flagged for review. The original request remains authoritative, and inferred requirements must never silently become approved scope.

The intent schema is independent of programming language and framework. Target detection is a lightweight hint only; Agents must inspect the actual repository and project artifacts before acting. Token savings must be measured with the destination model tokenizer and provider usage, while preserving enough context to complete and verify the requested task.


## Multilingual intent detection

The first multilingual layer detects Indonesian, English, Spanish, Portuguese, French, German, Japanese, and Chinese scripts using deterministic keyword/script heuristics. It adds a language signal to the prepared prompt and expands a bounded set of task and design phrases. This is not machine translation or broad multilingual semantic understanding. If the language is unsupported or the request cannot be safely represented by known rules, `requiresSemanticReview` remains true and the original prompt must be retained. Script detection alone does not imply that the request has been understood.

The canonical intent fields remain language-independent. Provider-specific token counting is deliberately separate: exact token counts require the destination model's tokenizer or authoritative provider usage data. Character counts and generic token-per-word ratios must not be reported as exact savings.


## Model-specific token measurement

The intelligence package provides a `TokenizerAdapter` contract and `measurePromptCompression` utility. Integrators must supply the exact tokenizer for the destination model/version. The utility reports original and optimized token counts, absolute savings, and percentage savings. It intentionally does not ship a generic word-to-token estimate and does not claim a provider's billed usage before the provider reports it. If no matching tokenizer adapter is available, report token savings as unmeasured rather than inventing a number.


## Trusted action adapter

The guard-core package exports `executeWithGuard` and `createActionScopeFingerprint`. A trusted tool handler wraps its real dispatch function with this adapter. It computes a SHA-256 fingerprint from the action class and canonicalized payload, asks a trusted authorization callback, and invokes the handler only when the callback returns `allowed: true`.

The authorization callback must read approval state from a trusted server-side source. Never trust an Agent-supplied authorization boolean or fingerprint. Compute the fingerprint immediately before dispatch from the exact payload that will be executed. Keep the dispatch function private and do not expose an alternate unguarded route. If the authorization service errors or is unavailable, execution stops. This is a reusable reference adapter, not a global OS sandbox: it cannot intercept arbitrary third-party tools, direct shell access, or provider calls that bypass the Gateway. Every integration must wrap all relevant execution paths.


## Guarded Agent adapters

The `@credit-guard/agent-adapter` workspace package provides filesystem, terminal, database-migration, and deployment boundaries. They share `executeWithGuard` and should use `createPostgresActionAuthorizer(pool)`, which reads the authoritative `cg_approval_requests` row directly and checks status, database-time expiry, project ID, required approval class, and exact fingerprint. Database errors propagate; there is no fail-open fallback.

- Filesystem: operates only below a configured canonical workspace root; rejects traversal and symlink targets, uses no-follow opens, and requires approval for overwrite/delete.
- Terminal: accepts only trusted host-registered executable profiles, uses argument arrays with `shell: false`, applies time/output limits, and requires security-sensitive approval for every command. The Agent cannot choose an executable path.
- Database: accepts only host-registered migrations with verified SHA-256 checksums. It executes each migration transactionally under a PostgreSQL advisory lock and records migration ID/checksum. The Agent cannot submit arbitrary SQL.
- Deployment: accepts only host-registered target handlers and requires production approval for the exact target/artifact reference.

These are privileged tool adapters, not a universal sandbox. Every path to the underlying resource must be routed through the adapter. Use least-privilege OS/container isolation and keep database connections, deployment credentials, provider keys, and approval authority outside Agent context. The generic deployment adapter requires a real provider-specific handler to be registered by the host.
