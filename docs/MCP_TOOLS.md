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
Call before substantial work. Input: `rawPrompt`, optional `projectMode`, `techStack`, and `constraints`. Output preserves the original request and provides a structured brief, unknowns, optional suggested requirements, task phases, and execution rules. Suggested requirements are not user-approved scope.

### `guard.failure.analyze`
Call before retrying a failed task. Supply the current `errorSignature`, `strategySignature`, and `previousAttempts` from project history. It returns `DIAGNOSE`, `REPLAN`, or `PAUSE`. Persist attempt history in project checkpoints so the analysis remains useful across sessions.

### `guard.intent.check_scope`
Compare `taskRequirementIds` with `approvedRequirementIds`. It returns `ALLOW` or `REVIEW`. This is a deterministic ID-based check and does not replace semantic review by the Agent.

### `guard.quality.evaluate`
Supply verification checks with `id`, `description`, `required`, `passed`, and optional `evidenceRef`. A required check cannot pass without both a passing result and an evidence reference.
