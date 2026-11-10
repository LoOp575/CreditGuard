# Roadmap

## Phase 1: MCP foundation
- [x] Repository initialized
- [x] MCP stdio server skeleton
- [x] Health tool
- [x] Caller-rate-based cost estimate tool
- [ ] Local install and protocol smoke test

## Phase 2: Credit Engine
- [ ] Project budget model
- [ ] Preflight policy
- [ ] Atomic reservations
- [ ] Usage reconciliation
- [ ] Concurrency and failure tests

## Phase 3: Project + Loop Engine
- [ ] Project lifecycle and evidence-based progress
- [ ] Retry/error loop detection
- [ ] Checkpoint save and resume contracts

## Phase 4: Decision Engine
- [ ] Explainable decision policy
- [ ] Budget + progress-aware decisions
- [ ] Policy configuration and test matrix

## Phase 5: Gateway enforcement
- [ ] Fastify gateway
- [ ] Provider adapter interface
- [ ] OpenAI, Anthropic, and Google adapters
- [ ] Credential isolation and request audit

## Phase 6: Validation
- [ ] Integration tests with representative agents
- [ ] Measure cost saved, false blocks, latency, and task completion
- [ ] Security review before production claims

No phase is considered production-ready until its tests and security review are complete.
