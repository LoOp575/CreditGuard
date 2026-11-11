import { Pool, type PoolClient } from "pg";
import {
  IdempotencyConflictError,
  InsufficientBudgetError,
  InvalidReservationStateError,
  ProjectAlreadyExistsError,
  ProjectNotFoundError,
  ReservationNotFoundError,
} from "./errors.js";
import type {
  CreditReservation, CreditStatus, CreateProjectBudgetInput, PreflightResult,
  ProjectBudget, ReserveCreditInput,
} from "./types.js";

function assertMicros(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer (USD micros)`);
}
function assertText(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`${field} must not be empty`);
}
function asNumber(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RangeError("Database monetary value exceeds safe integer range");
  return parsed;
}
function projectFrom(row: any): ProjectBudget {
  return { projectId: row.project_id, budgetMicros: asNumber(row.budget_micros),
    spentMicros: asNumber(row.spent_micros), createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString() };
}
function reservationFrom(row: any): CreditReservation {
  return { id: row.id, projectId: row.project_id, idempotencyKey: row.idempotency_key,
    reservedMicros: asNumber(row.reserved_micros),
    actualMicros: row.actual_micros === null ? null : asNumber(row.actual_micros),
    status: row.status, createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null };
}

/**
 * Durable PostgreSQL ledger. PostgreSQL row locks serialize budget mutations
 * per project; the unique project/idempotency constraint is the final replay guard.
 * Store USD micros as BIGINT and validate safe JS integer bounds at the boundary.
 */
export class PostgresCreditLedger {
  constructor(private readonly pool: Pool) {}

  async close(): Promise<void> { await this.pool.end(); }

  async createProjectBudget(input: CreateProjectBudgetInput): Promise<ProjectBudget> {
    assertText(input.projectId, "projectId"); assertMicros(input.budgetMicros, "budgetMicros");
    if (input.budgetMicros === 0) throw new TypeError("budgetMicros must be greater than zero");
    try {
      const result = await this.pool.query(
        "INSERT INTO cg_projects (project_id, budget_micros) VALUES ($1, $2) RETURNING *",
        [input.projectId, String(input.budgetMicros)],
      );
      return projectFrom(result.rows[0]);
    } catch (error: any) {
      if (error?.code === "23505") throw new ProjectAlreadyExistsError(input.projectId);
      throw error;
    }
  }

  async getStatus(projectId: string): Promise<CreditStatus> {
    assertText(projectId, "projectId");
    const result = await this.pool.query(`
      SELECT p.project_id, p.budget_micros, p.spent_micros,
        COALESCE(SUM(r.reserved_micros) FILTER (WHERE r.status = 'RESERVED'), 0)::bigint AS active_reserved_micros
      FROM cg_projects p LEFT JOIN cg_reservations r ON r.project_id = p.project_id
      WHERE p.project_id = $1 GROUP BY p.project_id`, [projectId]);
    if (!result.rowCount) throw new ProjectNotFoundError(projectId);
    const row = result.rows[0];
    const budgetMicros = asNumber(row.budget_micros);
    const spentMicros = asNumber(row.spent_micros);
    const activeReservedMicros = asNumber(row.active_reserved_micros);
    const net = budgetMicros - spentMicros - activeReservedMicros;
    return { projectId, budgetMicros, spentMicros, activeReservedMicros,
      availableMicros: Math.max(0, net), overBudget: net < 0, overspendMicros: Math.max(0, -net) };
  }

  async listReservations(projectId: string, status?: "RESERVED" | "SETTLED" | "RELEASED"): Promise<CreditReservation[]> {
    assertText(projectId, "projectId");
    const project = await this.pool.query("SELECT 1 FROM cg_projects WHERE project_id = $1", [projectId]);
    if (!project.rowCount) throw new ProjectNotFoundError(projectId);
    const result = await this.pool.query(
      "SELECT * FROM cg_reservations WHERE project_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at",
      [projectId, status ?? null],
    );
    return result.rows.map(reservationFrom);
  }

  async preflight(projectId: string, estimatedCostMicros: number): Promise<PreflightResult> {
    assertMicros(estimatedCostMicros, "estimatedCostMicros");
    const status = await this.getStatus(projectId);
    const allowed = estimatedCostMicros <= status.availableMicros;
    return { allowed, estimatedCostMicros, availableMicros: status.availableMicros,
      reason: allowed ? "WITHIN_BUDGET" : "INSUFFICIENT_BUDGET" };
  }

  async reserve(input: ReserveCreditInput): Promise<CreditReservation> {
    assertText(input.projectId, "projectId"); assertText(input.idempotencyKey, "idempotencyKey");
    assertMicros(input.estimatedCostMicros, "estimatedCostMicros");
    if (input.estimatedCostMicros === 0) throw new TypeError("estimatedCostMicros must be greater than zero");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query("SELECT * FROM cg_projects WHERE project_id = $1 FOR UPDATE", [input.projectId]);
      if (!project.rowCount) throw new ProjectNotFoundError(input.projectId);
      const prior = await client.query(
        "SELECT * FROM cg_reservations WHERE project_id = $1 AND idempotency_key = $2",
        [input.projectId, input.idempotencyKey],
      );
      if (prior.rowCount) {
        const existing = reservationFrom(prior.rows[0]);
        if (existing.reservedMicros !== input.estimatedCostMicros) throw new IdempotencyConflictError(input.idempotencyKey);
        await client.query("COMMIT");
        return existing;
      }
      const spent = asNumber(project.rows[0].spent_micros);
      const budget = asNumber(project.rows[0].budget_micros);
      const active = await client.query(
        "SELECT COALESCE(SUM(reserved_micros), 0)::bigint AS total FROM cg_reservations WHERE project_id = $1 AND status = 'RESERVED'",
        [input.projectId],
      );
      const available = Math.max(0, budget - spent - asNumber(active.rows[0].total));
      if (input.estimatedCostMicros > available) throw new InsufficientBudgetError(available, input.estimatedCostMicros);
      const inserted = await client.query(`
        INSERT INTO cg_reservations (project_id, idempotency_key, reserved_micros)
        VALUES ($1, $2, $3) RETURNING *`,
        [input.projectId, input.idempotencyKey, String(input.estimatedCostMicros)]);
      await client.query("COMMIT");
      return reservationFrom(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async settle(reservationId: string, actualCostMicros: number): Promise<CreditReservation> {
    assertText(reservationId, "reservationId"); assertMicros(actualCostMicros, "actualCostMicros");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reference = await client.query("SELECT project_id FROM cg_reservations WHERE id = $1", [reservationId]);
      if (!reference.rowCount) throw new ReservationNotFoundError(reservationId);
      // Keep lock order consistent with reserve(): project row first, reservation second.
      await client.query("SELECT project_id FROM cg_projects WHERE project_id = $1 FOR UPDATE", [reference.rows[0].project_id]);
      const found = await client.query("SELECT * FROM cg_reservations WHERE id = $1 FOR UPDATE", [reservationId]);
      if (!found.rowCount) throw new ReservationNotFoundError(reservationId);
      const reservation = reservationFrom(found.rows[0]);
      if (reservation.status === "SETTLED") {
        if (reservation.actualMicros !== actualCostMicros) throw new InvalidReservationStateError(reservation.status, "settle with different actual cost");
        await client.query("COMMIT"); return reservation;
      }
      if (reservation.status !== "RESERVED") throw new InvalidReservationStateError(reservation.status, "settle");
      await client.query("UPDATE cg_projects SET spent_micros = spent_micros + $2::bigint, updated_at = now() WHERE project_id = $1",
        [reservation.projectId, String(actualCostMicros)]);
      const updated = await client.query(
        "UPDATE cg_reservations SET status = 'SETTLED', actual_micros = $2::bigint, settled_at = now() WHERE id = $1 RETURNING *",
        [reservationId, String(actualCostMicros)]);
      await client.query("COMMIT");
      return reservationFrom(updated.rows[0]);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async release(reservationId: string): Promise<CreditReservation> {
    assertText(reservationId, "reservationId");
    const result = await this.pool.query(`
      UPDATE cg_reservations SET status = 'RELEASED'
      WHERE id = $1 AND status = 'RESERVED' RETURNING *`, [reservationId]);
    if (result.rowCount) return reservationFrom(result.rows[0]);
    const existing = await this.pool.query("SELECT * FROM cg_reservations WHERE id = $1", [reservationId]);
    if (!existing.rowCount) throw new ReservationNotFoundError(reservationId);
    const reservation = reservationFrom(existing.rows[0]);
    if (reservation.status === "RELEASED") return reservation;
    throw new InvalidReservationStateError(reservation.status, "release");
  }
}
