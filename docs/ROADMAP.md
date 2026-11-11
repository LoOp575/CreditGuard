# Roadmap

## Phase 1: MCP foundation
- [x] Repository initialized
- [x] MCP stdio server skeleton
- [x] Health tool
- [x] Caller-rate-based cost estimate tool
- [x] CI protocol smoke test: initialize + tools/list over stdio

## Phase 2: Credit Engine
- [x] Project budget model (in-memory reference implementation)
- [x] Preflight policy
- [x] Atomic reservations (single-process serialization)
- [x] Usage reconciliation
- [x] Concurrency and failure test cases added
- [x] PostgreSQL schema and durable ledger adapter implemented
- [x] MCP DATABASE_URL selection with explicit in-memory development fallback
- [x] PostgreSQL migration and adapter integration tests in CI
- [x] Concurrent reservation test against PostgreSQL
- [ ] Distributed load, crash-recovery, and failover tests

## Phase 3: Project + Loop Engine
- [x] Project lifecycle and evidence-based progress
- [x] PostgreSQL project and milestone persistence
- [x] Persistent retry/error loop detection
- [x] Checkpoint save and latest-resume contract
- [ ] External artifact verifier integration

## Phase 4: Decision Engine
- [x] Explainable decision policy
- [x] Budget + progress-aware decisions
- [x] Loop-aware pause and checkpoint recommendations
- [x] Context selection under a character budget
- [x] Cheaper-model fallback when the estimate is over/near remaining credit and a configured fallback is cheaper and affordable
- [ ] Configurable policy profiles and broader evaluation matrix

## Phase 5: Gateway enforcement
- [x] Fastify Gateway HTTP service
- [x] Provider adapter interface
- [x] OpenAI, Anthropic, and Google adapters
- [x] Project-scoped Gateway tokens
- [x] Provider keys isolated to Gateway-side secret configuration
- [x] PostgreSQL request outcome audit without prompt/key storage
- [x] Reservation recovery and unresolved Gateway request tools
- [x] Gateway end-to-end integration test with mocked provider and PostgreSQL
- [ ] Key rotation workflow and production secret-manager deployment

## Phase 6: Validation
- [x] PostgreSQL integration tests in CI
- [ ] Integration tests with representative agents
- [ ] Measure cost saved, false blocks, latency, and task completion
- [ ] Multi-process/load/failover tests
- [ ] Security review before production claims

No phase is considered production-ready until its tests and security review are complete.
