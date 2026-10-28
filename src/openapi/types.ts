import type { OpenAPIV3 } from "openapi-types";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RequestBodyKind = "data" | "form" | "multipart";
export type ResponseBodyKind = "json" | "text" | "empty";

export interface NormalizedParameter {
  name: string;
  argumentName: string;
  location: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: OpenAPIV3.SchemaObject;
}

export interface NormalizedRequestBody {
  mediaType: "application/json" | "application/x-www-form-urlencoded" | "multipart/form-data";
  kind: RequestBodyKind;
  required: boolean;
  schema: OpenAPIV3.SchemaObject;
}

export interface NormalizedResponse {
  status: string;
  body: ResponseBodyKind;
  mediaType?: string;
  schema?: OpenAPIV3.SchemaObject;
}

export interface NormalizedOperation {
  method: HttpMethod;
  path: string;
  name: string;
  typeName: string;
  tag: string;
  parameters: {
    path: NormalizedParameter[];
    query: NormalizedParameter[];
    header: NormalizedParameter[];
    cookie: NormalizedParameter[];
  };
  requestBody?: NormalizedRequestBody;
  responses: NormalizedResponse[];
}

export interface NormalizedGroup {
  tag: string;
  fileName: string;
  clientName: string;
  operations: NormalizedOperation[];
}

export interface NormalizedApi {
  inputHash: string;
  groups: NormalizedGroup[];
}

export interface NormalizeOptions {
  paths?: string[];
  ignoreHeaders?: string[];
}
