import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'error',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, message, 'bad_request', details);
export const unauthorized = (message = 'Missing or invalid credentials'): ApiError =>
  new ApiError(401, message, 'unauthorized');
export const notFound = (what: string): ApiError =>
  new ApiError(404, `${what} not found`, 'not_found');
export const tooManyRequests = (retryAfter: number): ApiError =>
  new ApiError(429, 'Rate limit exceeded', 'rate_limited', { retryAfter });

/**
 * Wraps a route handler with uniform error mapping.
 *
 * Unexpected errors are logged in full and returned as an opaque 500 — internal
 * messages and stack traces are never sent to a client, since a workflow error
 * can easily contain fragments of a prompt or a URL with a token in it.
 */
export function route<T extends unknown[]>(
  handler: (...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return async (...args: T) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApiError) {
        return NextResponse.json(
          { error: error.message, code: error.code, details: error.details },
          { status: error.status },
        );
      }
      if (error instanceof ZodError) {
        return NextResponse.json(
          {
            error: 'Request body failed validation',
            code: 'invalid_body',
            details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
          { status: 400 },
        );
      }
      console.error('[flowforge] unhandled route error', error);
      return NextResponse.json(
        { error: 'Internal server error', code: 'internal_error' },
        { status: 500 },
      );
    }
  };
}

export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Request body failed validation', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Token-bucket rate limiter, per key.
 *
 * In-process by design: it protects a single instance and needs no Redis for the
 * default deployment. A multi-instance deployment should front this with a shared
 * limiter — see `docs/deployment.md`.
 */
export function rateLimit(key: string, perMinute: number): void {
  if (perMinute <= 0) return;
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: perMinute, updatedAt: now };

  const refill = ((now - bucket.updatedAt) / 60_000) * perMinute;
  bucket.tokens = Math.min(perMinute, bucket.tokens + refill);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    throw tooManyRequests(Math.ceil((1 - bucket.tokens) * (60 / perMinute)));
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);

  // Opportunistic eviction keeps the map from growing without bound.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      if (now - b.updatedAt > 300_000) buckets.delete(k);
    }
  }
}

export function clientKey(request: Request, salt = ''): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return `${salt}:${forwarded ?? request.headers.get('x-real-ip') ?? 'local'}`;
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  return header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
}

export const json = NextResponse.json;
