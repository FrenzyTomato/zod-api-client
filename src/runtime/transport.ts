import type { FormPayload, HttpMethod, MultipartPayload } from "./types.js";

export interface TransportRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  form?: FormPayload;
  multipart?: MultipartPayload;
  timeout?: number;
}

export interface TransportResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}
