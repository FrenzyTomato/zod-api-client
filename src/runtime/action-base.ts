import type { z } from "zod";

import { ApiHttpError, ResponseValidationError } from "./errors.js";
import { axiosTransport, isAxiosLike, type AxiosLike } from "./axios.js";
import { fetchTransport } from "./fetch.js";
import { serializeFormValues } from "./multipart.js";
import { isPlaywrightRequestLike, playwrightTransport, type PlaywrightRequestLike } from "./playwright.js";
import type { HttpTransport } from "./transport.js";
import type {
  ClientOptions,
  ClientTarget,
  FormPayload,
  HttpMethod,
  PreparedRequest,
  QueryParameters,
  RequestData,
  RequestOptions,
} from "./types.js";

export class ActionBase {
  readonly #options: ClientOptions;
  readonly #transport: HttpTransport;

  public readonly context: ClientTarget | undefined;

  public constructor(target?: ClientTarget | ClientOptions, options?: ClientOptions) {
    if (isPlaywrightRequestLike(target)) {
      this.#transport = playwrightTransport(target);
    } else if (isAxiosLike(target)) {
      this.#transport = axiosTransport(target);
    } else if (isHttpTransport(target)) {
      this.#transport = target;
    } else {
      this.#transport = fetchTransport();
      options ??= target;
      target = undefined;
    }
    this.context = target;
    this.#options = options ?? {};
  }

  public get<T = unknown>(url: string, options: RequestOptions<T> = {}): Promise<T> {
    return this.#request("GET", url, options);
  }

  public post<T = unknown>(url: string, options: RequestOptions<T> = {}): Promise<T> {
    return this.#request("POST", url, options);
  }

  public put<T = unknown>(url: string, options: RequestOptions<T> = {}): Promise<T> {
    return this.#request("PUT", url, options);
  }

  public patch<T = unknown>(url: string, options: RequestOptions<T> = {}): Promise<T> {
    return this.#request("PATCH", url, options);
  }

  public delete<T = unknown>(url: string, options: RequestOptions<T> = {}): Promise<T> {
    return this.#request("DELETE", url, options);
  }

  protected validateRequest(schema: z.ZodType, value: unknown): void {
    if (this.#options.validateRequests) {
      schema.parse(value);
    }
  }

  async #request<T>(method: HttpMethod, url: string, options: RequestOptions<T>): Promise<T> {
    let prepared = prepareRequest(method, url, options);
    const hookResult = await this.#options.beforeRequest?.(prepared);
    if (hookResult) {
      prepared = hookResult;
    }

    assertSingleBody(prepared);

    const requestURL = appendParams(resolveURL(prepared.url, this.#options.baseURL), prepared.params);
    const response = await this.#transport.send({
      method: prepared.method,
      url: requestURL,
      headers: prepared.headers,
      data: prepared.data,
      form: prepared.form,
      multipart: prepared.multipart,
      timeout: prepared.timeout ?? this.#options.timeout,
    });
    const { status, body: rawBody, headers } = response;
    const responseURL = response.url || requestURL;

    if (status < 200 || status > 299) {
      throw new ApiHttpError({
        status,
        url: responseURL,
        headers,
        body: parseErrorBody(rawBody, headers),
      });
    }

    const body = parseSuccessBody(rawBody, headers, status, responseURL);
    if (!options.responseSchema) {
      return body as T;
    }

    const result = options.responseSchema.safeParse(body);
    if (!result.success) {
      throw new ResponseValidationError(`HTTP ${status} response does not match its generated schema`, {
        status,
        url: responseURL,
        body,
        cause: result.error,
      });
    }
    return result.data;
  }
}

function isHttpTransport(value: unknown): value is HttpTransport {
  return typeof (value as HttpTransport | undefined)?.send === "function";
}

function prepareRequest<T>(method: HttpMethod, url: string, options: RequestOptions<T>): PreparedRequest {
  assertSingleBody(options);
  return {
    method,
    url,
    headers: serializeHeaders(
      options.headers,
      options.cookies,
      options.data === undefined ? undefined : "application/json",
    ),
    params: serializeParams(options.params),
    data: options.data as RequestData,
    form: serializeForm(options.form),
    multipart: options.multipart,
    timeout: options.timeout,
  };
}

function assertSingleBody(request: Pick<RequestOptions, "data" | "form" | "multipart">): void {
  const bodyCount = [request.data, request.form, request.multipart].filter((body) => body !== undefined).length;
  if (bodyCount > 1) {
    throw new TypeError("A request may specify only one of data, form, or multipart");
  }
}

function serializeParams(params: QueryParameters | undefined): URLSearchParams | undefined {
  if (!params) {
    return undefined;
  }
  if (params instanceof URLSearchParams) {
    return new URLSearchParams(params);
  }

  const serialized = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => serialized.append(name, String(item)));
    } else {
      serialized.append(name, String(value));
    }
  }
  return serialized.toString() ? serialized : undefined;
}

function serializeHeaders(
  headers: RequestOptions["headers"],
  cookies: RequestOptions["cookies"],
  contentType?: string,
): Record<string, string> | undefined {
  const entries: Array<[string, string]> = Object.entries(headers ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [name, Array.isArray(value) ? value.map(String).join(",") : String(value)]);
  const cookieHeader = serializeCookies(cookies);
  if (cookieHeader) {
    const existingCookie = entries.findIndex(([name]) => name.toLowerCase() === "cookie");
    if (existingCookie === -1) {
      entries.push(["Cookie", cookieHeader]);
    } else {
      entries[existingCookie][1] = `${entries[existingCookie][1]}; ${cookieHeader}`;
    }
  }
  if (contentType && !entries.some(([name]) => name.toLowerCase() === "content-type")) {
    entries.unshift(["Content-Type", contentType]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serializeCookies(cookies: RequestOptions["cookies"]): string | undefined {
  const values = Object.entries(cookies ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  return values.length > 0 ? values.join("; ") : undefined;
}

function serializeForm(form: RequestOptions["form"]): FormPayload | undefined {
  if (!form || isFormData(form)) {
    return form;
  }
  return serializeFormValues(form as Record<string, unknown>) as FormPayload;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

function resolveURL(url: string, baseURL?: string): string {
  if (!baseURL || isAbsoluteURL(url)) {
    return url;
  }

  const normalizedBaseURL = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  try {
    return new URL(url.replace(/^\/+/, ""), normalizedBaseURL).toString();
  } catch (error) {
    throw new TypeError(`Cannot resolve request URL "${url}" against base URL "${baseURL}"`, { cause: error });
  }
}

function isAbsoluteURL(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function appendParams(url: string, params?: URLSearchParams): string {
  const serialized = params?.toString();
  if (!serialized) {
    return url;
  }

  const hashIndex = url.indexOf("#");
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  return `${withoutHash}${withoutHash.includes("?") ? "&" : "?"}${serialized}${hash}`;
}

function parseSuccessBody(
  rawBody: Uint8Array,
  headers: Record<string, string>,
  status: number,
  url: string,
): unknown {
  if (status === 204 || rawBody.length === 0) {
    return undefined;
  }

  const text = new TextDecoder().decode(rawBody);
  if (!isJSONContentType(headers)) {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ResponseValidationError(`HTTP ${status} response is not valid JSON`, {
      status,
      url,
      body: text,
      cause: error,
    });
  }
}

function parseErrorBody(rawBody: Uint8Array, headers: Record<string, string>): unknown {
  if (rawBody.length === 0) {
    return undefined;
  }

  const text = new TextDecoder().decode(rawBody);
  if (isJSONContentType(headers) || looksLikeJSON(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function isJSONContentType(headers: Record<string, string>): boolean {
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase().split(";", 1)[0].trim();
  return normalized === "application/json" || normalized.endsWith("+json");
}

function looksLikeJSON(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
