import { toFormBody, toFormData, withoutContentType } from "./form-data.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "./transport.js";

export interface AxiosLike {
  request(config: Record<string, unknown>): Promise<{
    status: number;
    headers: unknown;
    data: ArrayBuffer | Uint8Array;
    request?: { res?: { responseUrl?: string } };
  }>;
  interceptors: unknown;
}

export function isAxiosLike(value: unknown): value is AxiosLike {
  const candidate = value as Partial<AxiosLike> | null;
  return typeof candidate?.request === "function" && candidate !== null && "interceptors" in candidate;
}

export function axiosTransport(instance: AxiosLike): HttpTransport {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      let headers = request.headers;
      let data: unknown;
      if (request.multipart !== undefined) {
        data = toFormData(request.multipart);
        headers = withoutContentType(headers);
      } else if (request.form !== undefined) {
        data = toFormBody(request.form);
      } else {
        data = request.data;
      }

      const response = await instance.request({
        url: request.url,
        method: request.method,
        headers,
        data,
        timeout: request.timeout,
        responseType: "arraybuffer",
        validateStatus: () => true,
      });
      return {
        status: response.status,
        url: response.request?.res?.responseUrl ?? request.url,
        headers: normalizeHeaders(response.headers),
        body: new Uint8Array(response.data),
      };
    },
  };
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const source = typeof (headers as { toJSON?: unknown })?.toJSON === "function"
    ? (headers as { toJSON(): object }).toJSON()
    : (headers ?? {});
  return Object.fromEntries(
    Object.entries(source)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]),
  );
}
