import type { HttpTransport, TransportRequest, TransportResponse } from "./transport.js";

export interface PlaywrightRequestLike {
  fetch(
    url: string,
    options?: Record<string, unknown>,
  ): Promise<{
    status(): number;
    url(): string;
    headers(): Record<string, string>;
    body(): Promise<Uint8Array>;
  }>;
  storageState(...args: any[]): Promise<unknown>;
}

export function isPlaywrightRequestLike(value: unknown): value is PlaywrightRequestLike {
  const candidate = value as Partial<PlaywrightRequestLike> | null;
  return typeof candidate?.fetch === "function" && typeof candidate.storageState === "function";
}

export function playwrightTransport(context: PlaywrightRequestLike): HttpTransport {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      const response = await context.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        data: request.data,
        form: request.form,
        multipart: await toPlaywrightMultipart(request.multipart),
        timeout: request.timeout,
        failOnStatusCode: false,
      });
      return {
        status: response.status(),
        url: response.url(),
        headers: response.headers(),
        body: await response.body(),
      };
    },
  };
}

async function toPlaywrightMultipart(multipart: TransportRequest["multipart"]): Promise<unknown> {
  if (!multipart || multipart instanceof FormData) {
    return multipart;
  }

  const entries = await Promise.all(
    Object.entries(multipart).map(async ([name, value]) => {
      if (value instanceof Blob) {
        const buffer = Buffer.from(await value.arrayBuffer());
        return [name, { name: "name" in value && typeof value.name === "string" ? value.name : name, mimeType: value.type, buffer }];
      }
      if (value instanceof Uint8Array) {
        return [name, { name, mimeType: "application/octet-stream", buffer: Buffer.from(value) }];
      }
      if (typeof value === "object" && !Buffer.isBuffer(value.buffer)) {
        return [name, { ...value, buffer: Buffer.from(value.buffer) }];
      }
      return [name, value];
    }),
  );
  return Object.fromEntries(entries);
}
