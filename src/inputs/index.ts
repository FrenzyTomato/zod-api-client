import { readFile } from "node:fs/promises";

import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";
import { parse } from "yaml";

import { normalizeOpenApiDocument } from "../openapi/index.js";
import type { NormalizedApi } from "../openapi/types.js";
import { convertHar } from "./har.js";
import { filterUnsupportedOperations } from "./lenient.js";
import type { SkippedOperation } from "./lenient.js";
import { convertOpenApi31 } from "./openapi31.js";
import { convertPostman } from "./postman.js";
import { convertSwagger2 } from "./swagger2.js";

export interface LoadInputOptions {
  paths?: string[];
  ignoreHeaders?: string[];
  strict?: boolean;
  har?: { hosts?: string[] };
}

type Json = Record<string, any>;

const isUrl = (source: string): boolean => /^https?:\/\//i.test(source);

const readSource = async (source: string): Promise<string> => {
  if (!isUrl(source)) return readFile(source, "utf8");
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${source}: request failed with status ${response.status}`);
  return response.text();
};

const detectFormat = (raw: Json): "3.0" | "3.1" | "swagger2" | "postman" | "har" => {
  if (typeof raw?.openapi === "string" && raw.openapi.startsWith("3.0.")) return "3.0";
  if (typeof raw?.openapi === "string" && raw.openapi.startsWith("3.1.")) return "3.1";
  if (raw?.swagger === "2.0") return "swagger2";
  if (typeof raw?.info?.schema === "string" && raw.info.schema.includes("getpostman.com/json/collection")) {
    return "postman";
  }
  if (Array.isArray(raw?.log?.entries)) return "har";
  throw new Error("Unsupported API document format: expected OpenAPI 3.0/3.1, Swagger 2.0, a Postman collection or a HAR file");
};

export const loadInput = async (
  source: string,
  options: LoadInputOptions = {},
): Promise<{ api: NormalizedApi; skipped: SkippedOperation[] }> => {
  const raw = parse(await readSource(source)) as Json;
  const format = detectFormat(raw);
  let document: OpenAPIV3.Document;

  if (format === "postman") document = convertPostman(raw);
  else if (format === "har") document = convertHar(raw, options.har);
  else {
    const bundled = (await SwaggerParser.bundle(source, raw as OpenAPIV3.Document, isUrl(source) ? {} : { resolve: { http: false } })) as object;
    const converted =
      format === "3.1"
        ? convertOpenApi31(bundled)
        : format === "swagger2"
          ? await convertSwagger2(bundled)
          : (bundled as OpenAPIV3.Document);
    document = converted as OpenAPIV3.Document;
  }

  document = (await SwaggerParser.dereference(document, {
    dereference: { circular: false },
    resolve: { http: false },
  })) as OpenAPIV3.Document;
  const skipped = options.strict === false ? filterUnsupportedOperations(document, options) : [];
  const api = normalizeOpenApiDocument(document, { paths: options.paths, ignoreHeaders: options.ignoreHeaders });
  return { api, skipped };
};
