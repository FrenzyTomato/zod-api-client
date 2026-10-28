import type { z } from "zod";

interface ErrorBody {
  code?: unknown;
  message?: unknown;
  fields?: unknown;
}

export interface ApiHttpErrorOptions {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export class ApiHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly code?: string | number;
  readonly fields?: Record<string, unknown>;

  constructor(options: ApiHttpErrorOptions) {
    const errorBody = isRecord(options.body) ? (options.body as ErrorBody) : undefined;
    const responseMessage = typeof errorBody?.message === "string" ? errorBody.message : undefined;

    super(responseMessage ?? `HTTP ${options.status} returned from ${options.url}`);
    this.name = "ApiHttpError";
    this.status = options.status;
    this.url = options.url;
    this.headers = options.headers;
    this.body = options.body;

    if (typeof errorBody?.code === "string" || typeof errorBody?.code === "number") {
      this.code = errorBody.code;
    }
    if (isRecord(errorBody?.fields)) {
      this.fields = errorBody.fields;
    }
  }
}

export interface ResponseValidationErrorOptions {
  status: number;
  url: string;
  body: unknown;
  cause?: unknown;
}

export class ResponseValidationError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;
  readonly cause?: unknown;
  readonly issues?: z.ZodIssue[];

  constructor(message: string, options: ResponseValidationErrorOptions) {
    super(message);
    this.name = "ResponseValidationError";
    this.status = options.status;
    this.url = options.url;
    this.body = options.body;
    this.cause = options.cause;

    if (hasZodIssues(options.cause)) {
      this.issues = options.cause.issues;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasZodIssues(value: unknown): value is { issues: z.ZodIssue[] } {
  return isRecord(value) && Array.isArray(value.issues);
}
