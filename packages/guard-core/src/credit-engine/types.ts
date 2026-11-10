export type ReservationStatus = "RESERVED" | "SETTLED" | "RELEASED";

export interface CreateProjectBudgetInput {
  projectId: string;
  budgetMicros: number;
}

export interface ProjectBudget {
  projectId: string;
  budgetMicros: number;
  spentMicros: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveCreditInput {
  projectId: string;
  estimatedCostMicros: number;
  idempotencyKey: string;
}

export interface CreditReservation {
  id: string;
  projectId: string;
  idempotencyKey: string;
  reservedMicros: number;
  actualMicros: number | null;
  status: ReservationStatus;
  createdAt: string;
  settledAt: string | null;
}

export interface CreditStatus {
  projectId: string;
  budgetMicros: number;
  spentMicros: number;
  activeReservedMicros: number;
  availableMicros: number;
  overBudget: boolean;
  overspendMicros: number;
}

export interface PreflightResult {
  allowed: boolean;
  estimatedCostMicros: number;
  availableMicros: number;
  reason: "WITHIN_BUDGET" | "INSUFFICIENT_BUDGET";
}
