# Credit Guard Gateway

The Gateway is the enforcement path for provider calls. It exposes a provider-neutral text request envelope at `POST /v1/chat/completions`, accepts provider selection in headers, evaluates project state + credit + loop risk, reserves project credit in PostgreSQL before dispatch, and reconciles provider-reported token usage afterward.

Before using a project, create both records through MCP with the same ID: `guard.project.create` for lifecycle/milestones and `guard.credit.project.create` for its budget. The Gateway fails closed if either is missing.

## Security model

- Bind to loopback by default (`GATEWAY_HOST=127.0.0.1`).
- Each project has its own Gateway token in `GATEWAY_PROJECT_TOKENS_JSON`.
- Provider API keys are loaded by the Gateway process from `PROVIDER_API_KEYS_JSON`; Agents do not send provider keys.
- Never give the underlying provider key to an Agent that must be forced through the Gateway. Revoke old keys or credentials the Agent can still use directly.
- Use a secret manager or protected runtime environment for both JSON secret variables. Do not commit them.
- Fastify request logging is disabled; prompt bodies and provider keys are not written to the audit table.
- The audit table stores provider/model, reservation, usage, cost and outcome metadata only.

## Required configuration

- `DATABASE_URL`: PostgreSQL connection.
- `GATEWAY_PROJECT_TOKENS_JSON`: map project IDs to one random token or a non-empty array of overlapping tokens; each token must be at least 24 characters.
- `PROVIDER_API_KEYS_JSON`: map `provider:projectId` to provider API key.
- `PROVIDER_PRICING_JSON`: map `provider:model` to verified input/output USD-per-million-token rates.
- `MODEL_FALLBACKS_JSON`: optional same-provider fallback map from `provider:requestedModel` to a cheaper model.
- `ESTIMATE_SAFETY_MULTIPLIER`: optional estimate buffer, default 1.5.
- `GUARD_LOW_REMAINING_BUDGET_PERCENT`: trigger optimization below this percentage of original budget, default 10.
- `GUARD_LOW_PROGRESS_PERCENT`: trigger low-progress intervention below this verified milestone percentage, default 10.

Example shapes (replace all values with secrets and current provider rates):

```json
GATEWAY_PROJECT_TOKENS_JSON={"project-a":["CURRENT_RANDOM_TOKEN_AT_LEAST_24_CHARS","NEXT_RANDOM_TOKEN_AT_LEAST_24_CHARS"]}
PROVIDER_API_KEYS_JSON={"openai:project-a":"REPLACE_WITH_PROVIDER_SECRET"}
PROVIDER_PRICING_JSON={"openai:MODEL_ID":{"inputUsdPerMillion":1,"outputUsdPerMillion":2}}
```

The pricing numbers above are format examples only, not current price claims. Missing model pricing causes a fail-closed response. During project-token rotation, configure both old and new tokens temporarily, deploy, update the Agent, then remove the old token and redeploy.

## Request

Headers:
- `x-credit-guard-project`
- `x-credit-guard-token`
- `x-credit-guard-provider`: `openai`, `anthropic`, or `google`
- `x-idempotency-key`: unique 8-128 character key for each logical provider request. Reuse the same key when retrying the same logical request; the Gateway returns the existing request status without redispatching.

Body: `{ "model": "...", "messages": [{"role":"user","content":"..."}], "max_tokens": 1024 }`.

The Gateway runs Decision Engine and Loop Guard preflight before reserving credit. When credit is insufficient or near the low-balance threshold, it can automatically switch to a configured cheaper model from `MODEL_FALLBACKS_JSON`, but only when the fallback has a configured rate, costs less, and fits the available budget. The switch is returned transparently in `creditGuard.actualModel`. Without a valid fallback, it returns HTTP 409 with machine-readable reasons. A hard over-budget state, terminal project, repeated-error pause, or no-progress intervention is not bypassed by a cheaper model. Verified milestone evidence is what resets the no-progress counter.

The response contains the provider-native response under `provider` plus a `creditGuard` reconciliation summary. This is a provider-neutral request envelope, not a byte-for-byte OpenAI response proxy.

## Important limits

The input-token estimate uses a conservative character heuristic and a configurable buffer. Actual provider usage is authoritative after the call. If the provider omits usage or a network failure makes billing uncertain, the reservation remains held and the audit record is marked for manual reconciliation. Do not release it until provider billing status is known.

A reservation blocks requests whose estimated cost exceeds available project credit. It cannot guarantee the provider will never bill above the estimate. Maintain accurate pricing configuration, conservative output caps, and alerts for reconciliation overruns.
