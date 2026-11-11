# MCP Tool Reference

Credit Guard exposes advisory and control tools through the Model Context Protocol. Amounts ending in `Micros` are integer USD micros: 1 USD = 1,000,000 micros.

## Project and evidence

| Tool | Purpose |
|---|---|
| `guard.project.create` | Create a lifecycle project and milestones. |
| `guard.project.get` | Read project state, evidence, and progress. |
| `guard.project.transition` | Move through validated project states. |
| `guard.project.record_evidence` | Attach evidence as unverified. |
| `guard.project.verify_evidence` | Mark evidence verified after a trusted inspection, using the separate verifier secret. |

Evidence verification requires `EVIDENCE_VERIFIER_TOKEN`, which must be held by a trusted operator or verifier integration and must never be supplied to the Agent. The tool checks that secret in constant time, but it still does not independently inspect the artifact. A production deployment should connect it to a verifier that checks CI runs, artifact hashes, repository diffs, or other authoritative sources. An Agent's unverified self-report must not be treated as completed progress.

Project states: `CREATED`, `PLANNING`, `EXECUTING`, `VERIFYING`, `COMPLETED`, `PAUSED`, `BLOCKED`, `FAILED`. Terminal states cannot be reopened through ordinary transitions.

## Credit ledger

| Tool | Purpose |
|---|---|
| `guard.credit.estimate` | Calculate estimated USD cost from caller-supplied rates. |
| `guard.credit.project.create` | Create a project's budget. |
| `guard.credit.get_status` | Read budget, spend, reservations, and available credit. |
| `guard.credit.preflight` | Advisory check before reservation. |
| `guard.credit.reserve` | Atomically reserve estimated cost with an idempotency key. |
| `guard.credit.settle` | Reconcile a reservation to actual provider cost. |
| `guard.credit.release` | Release only when the request is confirmed not dispatched or not billable. |
| `guard.credit.list_reservations` | Inspect reservations by status for recovery. |

Create the lifecycle project and credit budget with the same project ID. For a USD 10 budget, use `budgetMicros: 10000000`. A preflight check alone is not a concurrency-safe spending control; reserve before dispatch.

Use one stable idempotency key for a logical provider request. Replays with the same key and amount return the original reservation. Reusing a key with a different amount is rejected.

If provider outcome is uncertain, do not release the reservation blindly. Inspect the Gateway unresolved list and reservation status, then settle from provider usage/billing data or release only after confirming no charge.

## Loop and decision

| Tool | Purpose |
|---|---|
| `guard.loop.record` | Record request, retry, or error events. |
| `guard.loop.assess` | Assess repeated errors, retries, and requests without verified progress. |
| `guard.decision.evaluate` | Combine budget, project state, progress, and loop risk. |

Verified milestone evidence records a progress event automatically. The Gateway also records provider requests and failures. A loop warning or pause takes priority over a cheaper-model fallback.

Decision thresholds are configurable through `GUARD_LOW_REMAINING_BUDGET_PERCENT` and `GUARD_LOW_PROGRESS_PERCENT` (both 0-100, default 10).

Decision actions:
- `ALLOW`: request fits current policy.
- `OPTIMIZE`: try a cheaper configured model or reduce context/output.
- `INTERVENE`: project state, loop risk, or low progress needs attention.
- `CHECKPOINT_PAUSE`: save state and pause before further spending.
- `BLOCK`: terminal or already over-budget state.

## Checkpoints and context

| Tool | Purpose |
|---|---|
| `guard.checkpoint.save` | Save goal, next step, artifact references, errors, and model configuration. |
| `guard.checkpoint.latest` | Retrieve the latest checkpoint. |
| `guard.context.optimize` | Select context sections under a character budget while preserving required sections. |

Never place provider keys, passwords, or other secrets in checkpoint payloads or context sections.

## Gateway recovery

| Tool | Purpose |
|---|---|
| `guard.gateway.unresolved` | List Gateway requests whose reservation is still active and billing/settlement needs reconciliation. |
| `guard.gateway.recover_request` | Recover an interrupted audit record by linking its reservation or safely marking a pre-dispatch orphan. |

The unresolved list contains metadata only, not prompts or credentials. Once a reservation is settled or released, it no longer appears as unresolved. Every Gateway call requires a project-scoped idempotency key; retries with the same key never redispatch the provider.

## Typical workflow

1. Create a lifecycle project with milestones.
2. Create a credit budget using the same project ID.
3. Move the project to `PLANNING`, then `EXECUTING`.
4. Estimate and reserve cost before each provider request.
5. Dispatch through the Gateway when hard routing enforcement is required.
6. Settle using provider-reported token usage; never assume a failed HTTP request is free.
7. Attach and verify milestone evidence as work completes.
8. Evaluate the next action. If a loop warning appears, stop and inspect the cause.
9. Save a checkpoint before pausing or handing work to another Agent.

## Operating modes

- Without `DATABASE_URL`, MCP uses in-memory development adapters. Data disappears on process restart and cannot coordinate across processes.
- With `DATABASE_URL`, MCP requires migrations 001, 002, and 003 and uses PostgreSQL for durable state.
- MCP alone is advisory. The Gateway is required to mediate provider calls, and direct provider credentials must not remain available to an Agent that is meant to be restricted.


## Prompt and execution intelligence

### `guard.prompt.prepare`
Call before substantial work. Input: `rawPrompt`, optional `projectMode`, `techStack`, and `constraints`. Output preserves the original request and provides an `objective`, phrase-to-technical `semanticInterpretations`, a concise `optimizedPrompt`, a `requiresSemanticReview` flag, unknowns, optional suggested requirements, task phases, and execution rules. When `requiresSemanticReview` is false, the Agent should send `optimizedPrompt` to the primary model rather than the raw request or the longer audit brief. When true, it must clarify or perform a separate semantic review before relying on the compressed form. The universal intent schema covers build, debug, modify, optimize, analyze, integrate, and other task types, with target, objective, requirements, constraints, context, expected output, and verification fields. Initial language detection uses conservative heuristics for Indonesian, English, Spanish, Portuguese, French, German, Japanese, and Chinese scripts; this is not full translation or semantic understanding. Unsupported or unrecognized requests remain review-required and the original prompt stays authoritative. The `TokenizerAdapter` and `measurePromptCompression` utility measure exact counts only when an integrator supplies the destination model's real tokenizer. Never estimate exact token savings from characters or word counts.

### `guard.failure.analyze`
Call before retrying a failed task. Supply `projectId`, the current `errorSignature`, `strategySignature`, and `previousAttempts` from project history. It returns `DIAGNOSE`, `REPLAN`, or `PAUSE`. It also records a combined error/strategy signature in the persistent Loop Guard when PostgreSQL mode is enabled. Persist detailed attempt history in project checkpoints so analysis remains useful across sessions.

### `guard.intent.check_scope`
Compare `taskRequirementIds` with `approvedRequirementIds`. It returns `ALLOW` or `REVIEW`. This is a deterministic ID-based check and does not replace semantic review by the Agent.

### `guard.quality.evaluate`
Supply verification checks with `id`, `description`, `required`, `passed`, and optional `evidenceRef`. A required check cannot pass without both a passing result and an evidence reference.


## Approval Gate

| Tool | Purpose |
|---|---|
| `guard.approval.request` | Create an idempotent, expiring approval request for a protected action. |
| `guard.approval.get` | Read the request state. |
| `guard.approval.resolve` | Approve or reject through a trusted approval interface; requires the server-side authority token. |
| `guard.approval.check` | Fail-closed check for the exact project, action class, and scope fingerprint before the protected action. |
| `guard.action.authorize` | One preflight contract for Agent tool adapters. Maps protected action types to required approval classes and returns `allowed: false` when approval is missing, expired, rejected, or mismatched. |

Protected action classes: `SCOPE_CHANGE`, `ARCHITECTURE_CHANGE`, `DESTRUCTIVE_ACTION`, `PRODUCTION_CHANGE`, `SPEND_LIMIT`, and `SECURITY_SENSITIVE`. A request defaults to a 60-minute expiry (configurable per request, maximum 7 days). Repeated request idempotency keys return the existing request. Approval is bound to the exact `projectId`, approval action class, and `scopeFingerprint`; changed scope or action class requires a new approval. Reusing an idempotency key with a different action, title, details, or scope fingerprint is rejected. Rejected, expired, missing, or mismatched approvals must be treated as denied. `guard.action.authorize` maps `FILE_OVERWRITE` and `FILE_DELETE` to `DESTRUCTIVE_ACTION`, `DEPLOY` and `DATABASE_MIGRATION` to `PRODUCTION_CHANGE`, `BUDGET_CHANGE` to `SPEND_LIMIT`, and scope, architecture, and security changes to their matching approval classes. Read-only, model-request, and ordinary file-write actions do not require this approval class by default; scope enforcement remains a separate check.

Set `APPROVAL_AUTHORITY_TOKEN` to a random secret of at least 24 characters. Only a trusted approval UI/operator integration may possess and submit it. Never put it in an Agent prompt, checkpoint, tool context, or logs. Apply migration `004_approval_gate.sql` before starting PostgreSQL mode. In-memory mode is development-only and loses approval records on restart.

**Enforcement boundary:** these MCP tools provide a fail-closed approval contract, but an external Agent can ignore the contract or bypass MCP unless its orchestration/runtime requires the check before protected tool execution. The current Gateway does not automatically intercept arbitrary filesystem, deployment, or third-party tool actions. Production enforcement requires integrating `guard.action.authorize` into the Agent orchestrator and each privileged tool adapter, with the approval authority kept outside the model's reach. The adapter must stop dispatch unless `allowed` is exactly `true`; merely calling the MCP tool does not prevent a bypass. The current Gateway still enforces provider budget and routing policy, not filesystem/deployment/database actions.


### Universal intent output

`guard.prompt.prepare` also returns an `intent` object for general software work:

| Field | Meaning |
|---|---|
| `taskType` | `build`, `debug`, `modify`, `optimize`, `analyze`, `integrate`, or `other` |
| `target` | Detected target such as web app, API, database, bot, developer tool, library, script, or component |
| `objective` | Concise statement of the requested outcome |
| `requirements` | Extracted requirements and explicitly marked suggestions |
| `constraints` | User-provided constraints that must be preserved |
| `context` | Supplied stack and project mode |
| `expectedOutput` | Expected deliverable for the task type |
| `verification` | Suggested checks appropriate to the task |

This is a deterministic first-pass schema, not a claim of full natural-language understanding. The original prompt remains authoritative. Agents must inspect project files, clarify critical unknowns, and verify changes with evidence. Do not assume a detected target or task type is sufficient to execute a change safely.


## Unified execution orchestrator

| Tool | Purpose |
|---|---|
| `guard.orchestrator.evaluate` | Combines prompt preparation, requirement-scope assessment, quality evidence, current project progress, loop risk, and credit decision into one execution recommendation. |

Input requires `projectId`, `rawPrompt`, estimated cost in USD micros, approved and requested requirement IDs, and quality checks. The tool reads the current credit status, project state/progress, and Loop Guard assessment from the configured stores. It returns the individual subsystem results, gate booleans, warnings, `executionStatus`, and `nextAction`.

Possible next actions: `BLOCK`, `PAUSE_AND_CHECKPOINT`, `OPTIMIZE_COST`, `ASK_FOR_CLARIFICATION`, `REQUEST_SCOPE_APPROVAL`, `EXECUTE_WITH_GUARDRAILS`, and `VERIFY_BEFORE_COMPLETION`.

This is an advisory decision-composition layer, not an action firewall. It does not automatically invoke a human approval UI, intercept filesystem/deployment tools, reserve credit, or dispatch provider requests. The Agent integration must obey the recommendation; the Gateway remains necessary for mediated provider spend enforcement. An empty approved requirement baseline deliberately returns scope review rather than silently allowing work.


## Trusted Agent adapter package

The workspace package `@credit-guard/agent-adapter` provides host-side adapters rather than additional public MCP tools:

| Adapter | Operation | Required approval |
|---|---|---|
| `GuardedFilesystemAdapter` | Workspace read/write/overwrite/delete | Overwrite/delete: `DESTRUCTIVE_ACTION` |
| `GuardedTerminalAdapter` | Run trusted executable profile | Every command: `SECURITY_SENSITIVE` |
| `GuardedDatabaseAdapter` | Run host-registered migration by ID | `PRODUCTION_CHANGE` |
| `GuardedDeploymentAdapter` | Invoke host-registered deployment target | `PRODUCTION_CHANGE` |

Use `createPostgresActionAuthorizer(pool)` as the adapter authorization callback. It reads `cg_approval_requests` directly and checks approval state, expiry using PostgreSQL time, project, approval class, and exact scope fingerprint. A missing approval or database error never dispatches the protected operation. The terminal action type `TERMINAL_COMMAND` maps to `SECURITY_SENSITIVE` in `guard.action.authorize`.

The terminal adapter does not invoke a shell and accepts only executable profiles registered by the host. The database adapter does not accept Agent-provided SQL; it accepts a trusted migration ID and validates the host-registered SQL checksum. The deployment adapter requires a trusted provider handler. None of these adapters can prevent bypass through unwrapped tools or direct host access. Keep the raw resource handles and credentials outside the Agent, and run the Agent in a least-privilege OS/container sandbox.
