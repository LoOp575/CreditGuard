export class CreditEngineError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CreditEngineError";
  }
}

export class ProjectAlreadyExistsError extends CreditEngineError {
  constructor(projectId: string) {
    super(`Project budget already exists: ${projectId}`, "PROJECT_ALREADY_EXISTS");
  }
}

export class ProjectNotFoundError extends CreditEngineError {
  constructor(projectId: string) {
    super(`Project budget not found: ${projectId}`, "PROJECT_NOT_FOUND");
  }
}

export class InsufficientBudgetError extends CreditEngineError {
  constructor(readonly availableMicros: number, readonly requestedMicros: number) {
    super("Insufficient available budget for this reservation", "INSUFFICIENT_BUDGET");
  }
}

export class IdempotencyConflictError extends CreditEngineError {
  constructor(key: string) {
    super(`Idempotency key was already used with different parameters: ${key}`, "IDEMPOTENCY_CONFLICT");
  }
}

export class ReservationNotFoundError extends CreditEngineError {
  constructor(reservationId: string) {
    super(`Reservation not found: ${reservationId}`, "RESERVATION_NOT_FOUND");
  }
}

export class InvalidReservationStateError extends CreditEngineError {
  constructor(status: string, operation: string) {
    super(`Cannot ${operation} a reservation in state ${status}`, "INVALID_RESERVATION_STATE");
  }
}
