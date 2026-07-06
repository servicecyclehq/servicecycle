import {
  ServiceCycleError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from './errors.js';

export interface HttpClientOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
}

function buildUrl(base: string, path: string, params?: Record<string, unknown>): string {
  const url = new URL(path, base.endsWith('/') ? base : base + '/');
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'boolean') {
        url.searchParams.set(key, value ? 'true' : 'false');
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.maxRetries = options.maxRetries ?? 3;
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', path, params);
  }

  async post<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>('POST', path, undefined, body, idempotencyKey);
  }

  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, unknown>,
    body?: unknown,
    idempotencyKey?: string,
    attempt = 0
  ): Promise<T> {
    const url = buildUrl(this.baseUrl, path, params);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429) {
      if (attempt >= this.maxRetries) {
        throw new RateLimitError(0);
      }
      const retryAfterHeader = response.headers.get('Retry-After');
      // [2026-07-05 review fix] Unbounded: a misbehaving or malicious server
      // sending "Retry-After: 999999" made every SDK call hang indefinitely,
      // and a non-numeric header produced NaN -> sleep(NaN) resolves as an
      // effectively-zero-delay hot-retry loop instead of backing off. Clamp
      // to a sane (0, 60]s window; fall back to 60s when absent, non-numeric,
      // or non-positive.
      const _parsedRetryAfter = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN;
      const retryAfterSeconds = Number.isFinite(_parsedRetryAfter) && _parsedRetryAfter > 0
        ? Math.min(_parsedRetryAfter, 60)
        : 60;
      const retryAfterMs = Math.ceil(retryAfterSeconds * 1000);
      await sleep(retryAfterMs);
      return this.request<T>(method, path, params, body, idempotencyKey, attempt + 1);
    }

    if (response.status === 401) throw new AuthenticationError();
    if (response.status === 403) throw new AuthorizationError();
    if (response.status === 404) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new NotFoundError(data.error ?? 'Resource');
    }
    if (response.status === 400) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new ValidationError(data.error ?? 'Validation error');
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new ServiceCycleError(data.error ?? `HTTP ${response.status}`, response.status, data);
    }

    return response.json() as Promise<T>;
  }
}
