import test from "node:test";
import assert from "node:assert/strict";
import { CreditEngine } from "./engine.js";
import { IdempotencyConflictError, InsufficientBudgetError } from "./errors.js";

test("reserves budget and reconciles actual usage", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-a", budgetMicros: 10_000_000 });

  const reservation = await engine.reserve({
    projectId: "project-a",
    estimatedCostMicros: 3_000_000,
    idempotencyKey: "request-1",
  });
  assert.equal((await engine.getStatus("project-a")).availableMicros, 7_000_000);

  await engine.settle(reservation.id, 2_500_000);
  const status = await engine.getStatus("project-a");
  assert.equal(status.spentMicros, 2_500_000);
  assert.equal(status.activeReservedMicros, 0);
  assert.equal(status.availableMicros, 7_500_000);
});

test("concurrent reservations cannot overspend the same budget", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-b", budgetMicros: 1_000 });

  const results = await Promise.allSettled([
    engine.reserve({ projectId: "project-b", estimatedCostMicros: 700, idempotencyKey: "a" }),
    engine.reserve({ projectId: "project-b", estimatedCostMicros: 700, idempotencyKey: "b" }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await engine.getStatus("project-b")).activeReservedMicros, 700);
});

test("same idempotency key returns the original reservation", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-c", budgetMicros: 1_000 });
  const input = { projectId: "project-c", estimatedCostMicros: 200, idempotencyKey: "same-key" };

  const first = await engine.reserve(input);
  const second = await engine.reserve(input);
  assert.equal(first.id, second.id);
  assert.equal((await engine.getStatus("project-c")).activeReservedMicros, 200);
});

test("idempotency key cannot be reused with a different amount", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-d", budgetMicros: 1_000 });
  await engine.reserve({ projectId: "project-d", estimatedCostMicros: 200, idempotencyKey: "same-key" });

  await assert.rejects(
    engine.reserve({ projectId: "project-d", estimatedCostMicros: 300, idempotencyKey: "same-key" }),
    IdempotencyConflictError,
  );
});

test("actual cost above estimate is recorded and over-budget state is visible", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-e", budgetMicros: 1_000 });
  const reservation = await engine.reserve({
    projectId: "project-e",
    estimatedCostMicros: 600,
    idempotencyKey: "request-overrun",
  });

  await engine.settle(reservation.id, 1_200);
  const status = await engine.getStatus("project-e");
  assert.equal(status.spentMicros, 1_200);
  assert.equal(status.overBudget, true);
  assert.equal(status.overspendMicros, 200);
});

test("released reservations free budget and cannot later be settled", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-f", budgetMicros: 1_000 });
  const reservation = await engine.reserve({
    projectId: "project-f",
    estimatedCostMicros: 800,
    idempotencyKey: "cancel-me",
  });

  await engine.release(reservation.id);
  assert.equal((await engine.getStatus("project-f")).availableMicros, 1_000);
  await assert.rejects(engine.settle(reservation.id, 0));
});

test("preflight explains whether an estimate fits", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-g", budgetMicros: 500 });
  assert.equal((await engine.preflight("project-g", 400)).reason, "WITHIN_BUDGET");
  assert.equal((await engine.preflight("project-g", 600)).reason, "INSUFFICIENT_BUDGET");
});

test("insufficient reservation returns a typed error", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-h", budgetMicros: 100 });
  await assert.rejects(
    engine.reserve({ projectId: "project-h", estimatedCostMicros: 101, idempotencyKey: "too-large" }),
    InsufficientBudgetError,
  );
});

test("settlement is idempotent when the same actual cost is replayed", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "project-i", budgetMicros: 1_000 });
  const reservation = await engine.reserve({
    projectId: "project-i",
    estimatedCostMicros: 300,
    idempotencyKey: "settle-replay",
  });

  const first = await engine.settle(reservation.id, 250);
  const replay = await engine.settle(reservation.id, 250);
  assert.equal(replay.status, "SETTLED");
  assert.equal(replay.actualMicros, 250);
  assert.equal(first.id, replay.id);
  assert.equal((await engine.getStatus("project-i")).spentMicros, 250);
});

test("lists reservations by project and status for recovery", async () => {
  const engine = new CreditEngine();
  await engine.createProjectBudget({ projectId: "list-p", budgetMicros: 1_000_000 });
  const reservation = await engine.reserve({ projectId: "list-p", estimatedCostMicros: 100_000, idempotencyKey: "list-1" });
  assert.equal((await engine.listReservations("list-p", "RESERVED")).length, 1);
  await engine.release(reservation.id);
  assert.equal((await engine.listReservations("list-p", "RESERVED")).length, 0);
  assert.equal((await engine.listReservations("list-p", "RELEASED")).length, 1);
});
