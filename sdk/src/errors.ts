export class ServiceCycleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly raw?: unknown
  ) {
    super(message);
    this.name = 'ServiceCycleError';
  }
}

export class AuthenticationError extends ServiceCycleError {
  constructor() {
    super('Invalid or missing API key', 401);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends ServiceCycleError {
  constructor(message = 'API key lacks the required scope') {
    super(message, 403);
    this.name = 'AuthorizationError';
  }
}

export class NotFoundError extends ServiceCycleError {
  constructor(resource: string) {
    super(`${resource} not found`, 404);
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends ServiceCycleError {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterMs}ms`, 429);
    this.name = 'RateLimitError';
  }
}

export class ValidationError extends ServiceCycleError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}
