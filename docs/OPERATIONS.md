# Operations Runbook

## First deployment

1. Provision PostgreSQL and take a backup.
2. Apply migrations 001, 002, and 003 in order.
3. Configure `DATABASE_URL`.
4. Create a lifecycle project and credit budget with the same project ID through MCP.
5. Configure `EVIDENCE_VERIFIER_TOKEN` for a trusted verifier/operator. Never expose it to the Agent.
6. Configure one project-scoped Gateway token and provider keys in a secret manager.
7. Configure verified model rates in `PROVIDER_PRICING_JSON`. Configure cheaper same-provider alternatives in `MODEL_FALLBACKS_JSON` where desired.
8. Start MCP and Gateway. Keep Gateway bound to loopback unless it is placed behind an authenticated TLS reverse proxy.
9. Remove or revoke direct provider credentials from any Agent that must be restricted to the Gateway.

## Rotate a project Gateway token

1. Generate a new cryptographically random token of at least 32 bytes.
2. Add the new token alongside the old token in that project's array in `GATEWAY_PROJECT_TOKENS_JSON`.
3. Restart/redeploy Gateway. Both tokens are now accepted during the overlap window.
4. Update the Agent's Gateway token configuration to the new token and verify a controlled request.
5. Remove the old token from the array and redeploy.
6. Verify the old token receives HTTP 401 and the new token still works.

Keep the overlap window short. Never log either token or place it in prompts/checkpoints. Do not put tokens in prompts, checkpoint payloads, logs, or source control.

## Rotate a provider key

1. Create a replacement key at the provider.
2. Update `PROVIDER_API_KEYS_JSON` in the Gateway secret manager.
3. Restart/redeploy Gateway.
4. Make a small controlled test request and verify usage settlement.
5. Revoke the old provider key.

Provider keys are loaded into Gateway memory and are not written to PostgreSQL. Avoid giving the provider key to Agents that are intended to use Gateway-only access.

## Reconcile an uncertain request

1. Call `guard.gateway.unresolved` for the project.
2. Find the request and reservation IDs and inspect the provider/model/status metadata.
3. Check the provider's usage or billing records using the provider's request/time information.
4. If usage is confirmed, call `guard.credit.settle` with the actual cost in USD micros.
5. If no request was dispatched or the provider confirms no charge, call `guard.credit.release`.
6. Re-run `guard.gateway.unresolved`; a settled or released reservation is no longer listed as unresolved.

Never release a reservation solely because the HTTP request failed. A timeout can happen after the provider has accepted and billed the request.

## Operational safeguards

- Keep database backups and test restore procedures.
- Restrict PostgreSQL network access and use least-privilege credentials.
- Keep Gateway behind TLS when accessed remotely.
- Rotate project tokens and provider keys after suspected exposure.
- Monitor active reservations and over-budget projects.
- Update model pricing when providers change their rates; missing model pricing fails closed.
- Review repeated-error and no-progress interventions before allowing a project to continue.
- Treat the character-based token estimate as an estimate, not a billing guarantee.
