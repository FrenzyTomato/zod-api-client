import { toFormBody, toFormData, withoutContentType } from "./form-data.js";
import type { HttpTransport, TransportRequest, TransportResponse } from "./transport.js";

export function fetchTransport(): HttpTransport {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      let headers = request.headers;
      let body: BodyInit | undefined;
      if (request.multipart !== undefined) {
        body = toFormData(request.multipart);
        headers = withoutContentType(headers);
      } else if (request.form !== undefined) {
        body = toFormBody(request.form);
      } else if (request.data !== undefined) {
        body =
          typeof request.data === "string" || request.data instanceof Uint8Array
            ? (request.data as BodyInit)
            : JSON.stringify(request.data);
      }

      const response = await globalThis.fetch(request.url, {
        method: request.method,
        headers,
        body,
        signal: request.timeout ? AbortSignal.timeout(request.timeout) : undefined,
      });
      return {
        status: response.status,
        url: response.url || request.url,
        headers: responseHeaders(response.headers),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

function responseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name.toLowerCase()] = value;
  });
  return result;
}
