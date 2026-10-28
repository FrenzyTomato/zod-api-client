import type { z } from "zod";

import type { AxiosLike } from "./axios.js";
import type { PlaywrightRequestLike } from "./playwright.js";
import type { HttpTransport } from "./transport.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | null | undefined | readonly QueryPrimitive[];
export type QueryParameters = URLSearchParams | Record<string, QueryValue>;
export type CookiePrimitive = string | number | boolean;
export type CookieValue = CookiePrimitive | null | undefined;
export type CookieParameters = Record<string, CookieValue>;

export type RequestData = unknown;
export type FormPayload = Record<string, string | number | boolean> | FormData;
export type UploadFile = Blob | Uint8Array | { name: string; mimeType: string; buffer: Uint8Array };
export type MultipartPayload = FormData | Record<string, string | number | boolean | UploadFile>;

export interface RequestOptions<T = unknown> {
  headers?: Record<string, unknown>;
  params?: QueryParameters;
  cookies?: CookieParameters;
  data?: unknown;
  form?: FormPayload | Record<string, unknown>;
  multipart?: MultipartPayload;
  timeout?: number;
  responseSchema?: z.ZodType<T>;
}

export interface PreparedRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  params?: URLSearchParams;
  data?: RequestData;
  form?: FormPayload;
  multipart?: MultipartPayload;
  timeout?: number;
}

export type BeforeRequest = (request: PreparedRequest) => PreparedRequest | void | Promise<PreparedRequest | void>;

export type ClientTarget = PlaywrightRequestLike | AxiosLike | HttpTransport;

export interface ClientOptions {
  baseURL?: string;
  timeout?: number;
  validateRequests?: boolean;
  beforeRequest?: BeforeRequest;
}
