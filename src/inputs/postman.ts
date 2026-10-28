import type { OpenAPIV3 } from "openapi-types";
import { inferSchema } from "./infer-schema.js";

type Json = Record<string, any>;

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const SKIPPED_HEADERS = new Set(["authorization", "content-type", "accept", "cookie"]);
const STRING_SCHEMA: OpenAPIV3.SchemaObject = { type: "string" };

const parseJson = (text: unknown): { value: unknown } | undefined => {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

// Bare {{var}} placeholders aren't valid JSON; quoted ones are already strings.
const fillPlaceholders = (raw: unknown): unknown =>
  typeof raw === "string" ? raw.replace(/("(?:[^"\\]|\\.)*")|\{\{[^}]+\}\}/g, (match, quoted) => quoted ?? "null") : raw;

const urlQuery = (url: unknown): Json[] => {
  if (url && typeof url === "object") {
    const { query, raw } = url as Json;
    return Array.isArray(query) ? query : urlQuery(raw);
  }
  if (typeof url !== "string" || !url.includes("?")) return [];
  return url
    .split("?", 2)[1]
    .split("#", 1)[0]
    .split("&")
    .map((pair) => ({ key: decodeURIComponent(pair.split("=", 1)[0]) }));
};

const urlSegments = (url: unknown): string[] => {
  if (url && typeof url === "object") {
    const { path, raw } = url as Json;
    if (Array.isArray(path)) {
      return path.map((segment) => (typeof segment === "string" ? segment : String(segment?.value ?? "")));
    }
    if (typeof raw === "string") return urlSegments(raw);
    return [];
  }
  if (typeof url !== "string") return [];
  const pathname = url.split(/[?#]/, 1)[0];
  const relative = pathname.startsWith("/") ? pathname : pathname.replace(/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/]*/i, "");
  return relative.split("/");
};

const templateSegment = (segment: string, names: string[]): string => {
  const name = /^:(.+)$/.exec(segment)?.[1] ?? /^\{\{([^}]+)\}\}$/.exec(segment)?.[1];
  if (!name) return segment;
  names.push(name);
  return `{${name}}`;
};

const bodySchema = (body: Json, examples: Json[]): OpenAPIV3.RequestBodyObject | undefined => {
  if (body.mode === "raw") {
    const samples = [body.raw, ...examples.map((example) => example.originalRequest?.body?.raw)]
      .map((raw) => parseJson(fillPlaceholders(raw)))
      .filter((sample) => sample !== undefined)
      .map((sample) => sample.value);
    if (samples.length === 0) return undefined;
    return { content: { "application/json": { schema: inferSchema(samples) } } };
  }
  const entries: Json[] = (body.mode === "urlencoded" ? body.urlencoded : body.formdata) ?? [];
  const properties = Object.fromEntries(
    entries
      .filter((entry) => !entry.disabled)
      .map((entry): [string, OpenAPIV3.SchemaObject] => [
        entry.key,
        entry.type === "file" ? { type: "string", format: "binary" } : STRING_SCHEMA,
      ]),
  );
  if (body.mode !== "urlencoded" && body.mode !== "formdata") return undefined;
  const mediaType = body.mode === "urlencoded" ? "application/x-www-form-urlencoded" : "multipart/form-data";
  return { content: { [mediaType]: { schema: { type: "object", properties } } } };
};

const buildResponses = (examples: Json[]): OpenAPIV3.ResponsesObject => {
  const responses: OpenAPIV3.ResponsesObject = {};
  const byCode = new Map<string, Json[]>();
  for (const example of examples) {
    const code = String(example.code ?? "200");
    byCode.set(code, [...(byCode.get(code) ?? []), example]);
  }
  for (const [code, group] of byCode) {
    const bodies = group.map((example) => example.body).filter((body) => typeof body === "string" && body.trim() !== "");
    const parsed = bodies.map(parseJson);
    if (bodies.length === 0) {
      responses[code] = { description: group[0].status ?? code };
    } else if (parsed.every((entry) => entry !== undefined)) {
      responses[code] = {
        description: group[0].status ?? code,
        content: { "application/json": { schema: inferSchema(parsed.map((entry) => entry!.value)) } },
      };
    } else {
      responses[code] = {
        description: group[0].status ?? code,
        content: { "text/plain": { schema: STRING_SCHEMA } },
      };
    }
  }
  if (!Object.keys(responses).some((code) => code.startsWith("2"))) {
    responses["200"] = { description: "OK", content: { "application/json": { schema: {} } } };
  }
  return responses;
};

const buildOperation = (item: Json, tag: string): { method: string; path: string; operation: OpenAPIV3.OperationObject } | undefined => {
  const request = item.request;
  const method = String(request.method ?? "GET").toLowerCase();
  if (!METHODS.has(method)) return undefined;
  const names: string[] = [];
  const path = `/${urlSegments(request.url)
    .filter((segment) => segment !== "")
    .map((segment) => templateSegment(segment, names))
    .join("/")}`;
  const examples: Json[] = item.response ?? [];
  const parameters: OpenAPIV3.ParameterObject[] = [
    ...names.map((name): OpenAPIV3.ParameterObject => ({ name, in: "path", required: true, schema: STRING_SCHEMA })),
    ...urlQuery(request.url)
      .filter((query) => !query.disabled && query.key)
      .map((query): OpenAPIV3.ParameterObject => ({ name: query.key, in: "query", required: false, schema: STRING_SCHEMA })),
    ...((Array.isArray(request.header) ? request.header : []) as Json[])
      .filter((header) => !header.disabled && header.key && !SKIPPED_HEADERS.has(String(header.key).toLowerCase()))
      .map((header): OpenAPIV3.ParameterObject => ({ name: header.key, in: "header", required: false, schema: STRING_SCHEMA })),
  ];
  const requestBody = request.body ? bodySchema(request.body, examples) : undefined;
  return {
    method,
    path,
    operation: {
      operationId: item.name,
      ...(tag ? { tags: [tag] } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: buildResponses(examples),
    },
  };
};

export const convertPostman = (collection: Json): OpenAPIV3.Document => {
  const paths: OpenAPIV3.PathsObject = {};
  const nameCounts = new Map<string, number>();
  const walk = (items: Json[], tag: string): void => {
    for (const item of items) {
      if (Array.isArray(item.item)) {
        walk(item.item, [tag, item.name].filter(Boolean).join(" "));
        continue;
      }
      if (!item.request || typeof item.request !== "object") continue;
      const built = buildOperation(item, tag);
      if (!built) continue;
      const count = (nameCounts.get(item.name) ?? 0) + 1;
      nameCounts.set(item.name, count);
      if (count > 1) built.operation.operationId = `${item.name} ${count}`;
      const pathItem = (paths[built.path] ??= {}) as Record<string, OpenAPIV3.OperationObject>;
      pathItem[built.method] ??= built.operation;
    }
  };
  walk(collection.item ?? [], "");
  return {
    openapi: "3.0.3",
    info: { title: collection.info?.name ?? "Postman collection", version: "1.0.0" },
    paths,
  };
};
