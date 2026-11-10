import {
  IdempotencyConflictError,
  InsufficientBudgetError,
  InvalidReservationStateError,
  ProjectAlreadyExistsError,
  ProjectNotFoundError,
  ReservationNotFoundError,
} from "./errors.js";
import type {
  CreditReservation,
  CreditStatus,
  CreateProjectBudgetInput,
  PreflightResult,
  ProjectBudget,
  ReserveCreditInput,
} from "./types.js";

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer (USD micros)`);
  }
}

function assertIdentifier(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`${field} must not be empty`);
}

/**
 * In-memory reference ledger.
 *
 * All mutations are serialized inside this process. This is useful for the
 * foundation and tests, but it is NOT a distributed lock or durable ledger.
 * Production Gateway deployments must replace this with a transactional
 * database implementation (and enforce uniqueness at the database layer).
 */
export class CreditEngine {
  private readonly projects = new Map<string, ProjectBudget>();
  private readonly reservations = new Map<string, CreditReservation>();
  private readonly idempotency = new Map<string, string>();
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async createProjectBudget(input: CreateProjectBudgetInput): Promise<ProjectBudget> {
    assertIdentifier(input.projectId, "projectId");
    assertNonNegativeSafeInteger(input.budgetMicros, "budgetMicros");
    if (input.budgetMicros === 0) throw new TypeError("budgetMicros must be greater than zero");

    return this.exclusive(() => {
      if (this.projects.has(input.projectId)) throw new ProjectAlreadyExistsError(input.projectId);
      const now = new Date().toISOString();
      const project: ProjectBudget = {
        projectId: input.projectId,
        budgetMicros: input.budgetMicros,
        spentMicros: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.projects.set(input.projectId, project);
      return { ...project };
    });
  }

  async preflight(projectId: string, estimatedCostMicros: number): Promise<PreflightResult> {
    assertNonNegativeSafeInteger(estimatedCostMicros, "estimatedCostMicros");
    const status = await this.getStatus(projectId);
    return {
      allowed: estimatedCostMicros <= status.availableMicros,
      estimatedCostMicros,
      availableMicros: status.availableMicros,
      reason: estimatedCostMicros <= status.availableMicros ? "WITHIN_BUDGET" : "INSUFFICIENT_BUDGET",
    };
  }

  async reserve(input: ReserveCreditInput): Promise<CreditReservation> {
    assertIdentifier(input.projectId, "projectId");
    assertIdentifier(input.idempotencyKey, "idempotencyKey");
    assertNonNegativeSafeInteger(input.estimatedCostMicros, "estimatedCostMicros");
    if (input.estimatedCostMicros === 0) throw new TypeError("estimatedCostMicros must be greater than zero");

    return this.exclusive(() => {
      const project = this.projects.get(input.projectId);
      if (!project) throw new ProjectNotFoundError(input.projectId);

      const indexKey = `${input.projectId}:${input.idempotencyKey}`;
      const existingId = this.idempotency.get(indexKey);
      if (existingId) {
        const existing = this.reservations.get(existingId)!;
        if (existing.reservedMicros !== input.estimatedCostMicros) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { ...existing };
      }

      const activeReserved = this.sumActiveReservations(input.projectId);
      const available = Math.max(0, project.budgetMicros - project.spentMicros - activeReserved);
      if (input.estimatedCostMicros > available) {
        throw new InsufficientBudgetError(available, input.estimatedCostMicros);
      }

      const reservation: CreditReservation = {
        id: `res_${++this.sequence}`,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        reservedMicros: input.estimatedCostMicros,
        actualMicros: null,
        status: "RESERVED",
        createdAt: new Date().toISOString(),
        settledAt: null,
      };
      this.reservations.set(reservation.id, reservation);
      this.idempotency.set(indexKey, reservation.id);
      return { ...reservation };
    });
  }

  async settle(reservationId: string, actualCostMicros: number): Promise<CreditReservation> {
    assertIdentifier(reservationId, "reservationId");
    assertNonNegativeSafeInteger(actualCostMicros, "actualCostMicros");

    return this.exclusive(() => {
      const reservation = this.reservations.get(reservationId);
      if (!reservation) throw new ReservationNotFoundError(reservationId);

      if (reservation.status === "SETTLED") {
        if (reservation.actualMicros !== actualCostMicros) {
          throw new InvalidReservationStateError(reservation.status, "settle with different actual cost");
        }
        return { ...reservation };
      }
      if (reservation.status !== "RESERVED") {
        throw new InvalidReservationStateError(reservation.status, "settle");
      }

      const project = this.projects.get(reservation.projectId)!;
      project.spentMicros += actualCostMicros;
      project.updatedAt = new Date().toISOString();
      reservation.actualMicros = actualCostMicros;
      reservation.status = "SETTLED";
      reservation.settledAt = project.updatedAt;
      return { ...reservation };
    });
  }

  async release(reservationId: string): Promise<CreditReservation> {
    assertIdentifier(reservationId, "reservationId");
    return this.exclusive(() => {
      const reservation = this.reservations.get(reservationId);
      if (!reservation) throw new ReservationNotFoundError(reservationId);
      if (reservation.status === "RELEASED") return { ...reservation };
      if (reservation.status !== "RESERVED") {
        throw new InvalidReservationStateError(reservation.status, "release");
      }
      reservation.status = "RELEASED";
      return { ...reservation };
    });
  }

  async getStatus(projectId: string): Promise<CreditStatus> {
    assertIdentifier(projectId, "projectId");
    return this.exclusive(() => {
      const project = this.projects.get(projectId);
      if (!project) throw new ProjectNotFoundError(projectId);
      const activeReservedMicros = this.sumActiveReservations(projectId);
      const netRemaining = project.budgetMicros - project.spentMicros - activeReservedMicros;
      return {
        projectId,
        budgetMicros: project.budgetMicros,
        spentMicros: project.spentMicros,
        activeReservedMicros,
        availableMicros: Math.max(0, netRemaining),
        overBudget: netRemaining < 0,
        overspendMicros: Math.max(0, -netRemaining),
      };
    });
  }

  private sumActiveReservations(projectId: string): number {
    let total = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.projectId === projectId && reservation.status === "RESERVED") {
        total += reservation.reservedMicros;
      }
    }
    return total;
  }
}
