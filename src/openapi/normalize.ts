import { createHash } from "node:crypto";

import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";
import { toCamelCase, toPascalCase } from "./naming.js";
import type {
  HttpMethod,
  NormalizeOptions,
  NormalizedApi,
  NormalizedGroup,
  NormalizedOperation,
  NormalizedParameter,
  NormalizedRequestBody,
  NormalizedResponse,
} from "./types.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const UNSUPPORTED_HTTP_METHODS = ["head", "options", "trace"] as const;
const REQUEST_MEDIA: Record<string, Pick<NormalizedRequestBody, "mediaType" | "kind">> = {
  "application/json": { mediaType: "application/json", kind: "data" },
  "application/x-www-form-urlencoded": { mediaType: "application/x-www-form-urlencoded", kind: "form" },
  "multipart/form-data": { mediaType: "multipart/form-data", kind: "multipart" },
};

const operationLabel = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

const asSchema = (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject | undefined,
  location: string,
): OpenAPIV3.SchemaObject => {
  if (!schema) {
    return {};
  }
  if ("$ref" in schema) {
    throw new Error(`${location}: unresolved schema reference ${schema.$ref}`);
  }
  return schema;
};

const schemaShapes = (schema: OpenAPIV3.SchemaObject): Set<string> => {
  const shapes = new Set<string>();
  if (schema.type) shapes.add(schema.type);
  else if (schema.properties || schema.additionalProperties !== undefined) shapes.add("object");
  else if ("items" in schema && schema.items) shapes.add("array");
  else if (schema.enum) {
    for (const value of schema.enum) {
      if (value === null) shapes.add("null");
      else if (Array.isArray(value)) shapes.add("array");
      else shapes.add(typeof value);
    }
  }
  const composition = schema.oneOf ?? schema.anyOf ?? schema.allOf;
  if (composition) {
    for (const member of composition) {
      if (!("$ref" in member)) {
        for (const shape of schemaShapes(member)) shapes.add(shape);
      }
    }
  }
  if (shapes.size === 0) shapes.add("unknown");
  return shapes;
};

const schemaShape = (schema: OpenAPIV3.SchemaObject): string | undefined => {
  const shapes = schemaShapes(schema);
  return shapes.size === 1 ? [...shapes][0] : undefined;
};

const arraySchemas = (schema: OpenAPIV3.SchemaObject): OpenAPIV3.ArraySchemaObject[] => {
  const arrays: OpenAPIV3.ArraySchemaObject[] = [];
  if (schema.type === "array" && "items" in schema) arrays.push(schema as OpenAPIV3.ArraySchemaObject);
  for (const member of schema.oneOf ?? schema.anyOf ?? schema.allOf ?? []) {
    if (!("$ref" in member)) arrays.push(...arraySchemas(member));
  }
  return arrays;
};

const normalizeParameter = (
  value: OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject,
  label: string,
  ignoreHeaders: Set<string>,
): NormalizedParameter | undefined => {
  if ("$ref" in value) {
    throw new Error(`${label}: unresolved parameter reference ${value.$ref}`);
  }
  if (value.in !== "path" && value.in !== "query" && value.in !== "header" && value.in !== "cookie") {
    return undefined;
  }
  if (value.in === "header" && ignoreHeaders.has(value.name.toLowerCase())) {
    return undefined;
  }
  if (!value.schema) {
    throw new Error(`${label}: parameter ${value.name} uses unsupported content-based schema`);
  }

  const schema = asSchema(value.schema, `${label} parameter ${value.name}`);
  const shapes = schemaShapes(schema);
  if (shapes.has("object")) {
    throw new Error(`${label}: object parameter ${value.name} in ${value.in} is not supported`);
  }
  if (shapes.has("unknown")) {
    throw new Error(`${label}: parameter ${value.name} has an unsupported unconstrained schema`);
  }
  if (
    value.in === "cookie" &&
    (schema.nullable || [...shapes].some((shape) => !["string", "number", "integer", "boolean"].includes(shape)))
  ) {
    throw new Error(
      `${label}: cookie parameter ${value.name} must use a primitive string, number, or boolean schema`,
    );
  }

  const defaultStyle = value.in === "query" || value.in === "cookie" ? "form" : "simple";
  const style = value.style ?? defaultStyle;
  if (style !== defaultStyle) {
    throw new Error(`${label}: parameter ${value.name} uses unsupported ${value.in} style ${style}`);
  }
  if (value.allowReserved) {
    throw new Error(`${label}: parameter ${value.name} uses unsupported allowReserved serialization`);
  }
  if (value.in === "query" && shapes.has("array") && value.explode === false) {
    throw new Error(`${label}: array query parameter ${value.name} uses unsupported explode=false serialization`);
  }
  if (value.in === "path" && shapes.has("array")) {
    throw new Error(`${label}: array path parameter ${value.name} is not supported`);
  }
  for (const arraySchema of arraySchemas(schema)) {
    const itemSchema = asSchema(arraySchema.items, `${label} parameter ${value.name} items`);
    const itemShapes = schemaShapes(itemSchema);
    if (
      itemShapes.has("object") ||
      itemShapes.has("array") ||
      itemShapes.has("null") ||
      itemShapes.has("unknown") ||
      itemSchema.nullable
    ) {
      throw new Error(`${label}: parameter ${value.name} uses unsupported complex array items`);
    }
  }

  return {
    name: value.name,
    argumentName: toCamelCase(value.name, "value"),
    location: value.in,
    required: value.in === "path" ? true : Boolean(value.required),
    schema,
  };
};

const mergeParameters = (
  pathParameters: Array<OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject> = [],
  operationParameters: Array<OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject> = [],
): Array<OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject> => {
  const merged = new Map<string, OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject>();
  for (const parameter of [...pathParameters, ...operationParameters]) {
    const key = "$ref" in parameter ? parameter.$ref : `${parameter.in}:${parameter.name}`;
    merged.set(key, parameter);
  }
  return [...merged.values()];
};

const normalizeRequestBody = (
  value: OpenAPIV3.ReferenceObject | OpenAPIV3.RequestBodyObject | undefined,
  label: string,
): NormalizedRequestBody | undefined => {
  if (!value) return undefined;
  if ("$ref" in value) {
    throw new Error(`${label}: unresolved request body reference ${value.$ref}`);
  }
  const supported = Object.entries(value.content).filter(([mediaType]) => mediaType in REQUEST_MEDIA);
  if (supported.length === 0) {
    throw new Error(`${label}: request body has no supported media type`);
  }
  // A generated operation has one stable call shape. When a document offers
  // alternatives, its first supported content entry is the selected shape.
  const [mediaType, media] = supported[0];
  const mapped = REQUEST_MEDIA[mediaType];
  const schema = asSchema(media.schema, `${label} request body`);
  if (mapped.kind !== "data" && (schemaShape(schema) !== "object" || schema.nullable)) {
    throw new Error(`${label}: ${mediaType} request body must use a non-nullable object schema`);
  }
  return {
    ...mapped,
    required: Boolean(value.required),
    schema,
  };
};

const responseKind = (mediaType: string): "json" | "text" | undefined => {
  const normalized = mediaType.toLowerCase().split(";", 1)[0].trim();
  if (normalized === "application/json" || normalized.endsWith("+json")) return "json";
  if (normalized.startsWith("text/")) return "text";
  return undefined;
};

const normalizeResponses = (responses: OpenAPIV3.ResponsesObject, label: string): NormalizedResponse[] => {
  const normalized: NormalizedResponse[] = [];
  for (const [status, value] of Object.entries(responses)) {
    if (!/^2(?:\d{2}|XX)$/i.test(status)) continue;
    if ("$ref" in value) {
      throw new Error(`${label} response ${status}: unresolved response reference ${value.$ref}`);
    }
    if (status === "204" || !value.content || Object.keys(value.content).length === 0) {
      normalized.push({ status: status.toUpperCase(), body: "empty" });
      continue;
    }

    const entries = Object.entries(value.content).map(([mediaType, media]) => ({
      mediaType,
      media,
      body: responseKind(mediaType),
    }));
    const unsupported = entries.filter((entry) => entry.body === undefined);
    if (unsupported.length > 0) {
      throw new Error(
        `${label} response ${status}: unsupported media type(s) ${unsupported.map((entry) => entry.mediaType).join(", ")}`,
      );
    }
    const supported = entries as Array<(typeof entries)[number] & { body: "json" | "text" }>;
    for (const selected of supported) {
      normalized.push({
        status: status.toUpperCase(),
        body: selected.body,
        mediaType: selected.mediaType,
        schema:
          selected.body === "text" && !selected.media.schema
            ? ({ type: "string" } as OpenAPIV3.SchemaObject)
            : asSchema(selected.media.schema, `${label} response ${status} ${selected.mediaType}`),
      });
    }
  }
  if (normalized.length === 0) {
    throw new Error(`${label}: no documented 2xx response`);
  }
  return normalized;
};

const makeOperationName = (operation: OpenAPIV3.OperationObject, method: string, path: string): string => {
  const fallback = `${method} ${path}`;
  if (operation.operationId) return toCamelCase(operation.operationId, fallback);
  if (operation.summary) return toCamelCase(operation.summary, fallback);
  return toCamelCase(fallback, `${method}Operation`);
};

const generatedSymbols = (
  operation: NormalizedOperation,
): Array<{ kind: "client" | "schema value" | "schema type"; name: string }> => {
  const symbols: Array<{ kind: "client" | "schema value" | "schema type"; name: string }> = [
    { kind: "client", name: operation.name },
  ];
  if (operation.requestBody?.kind === "multipart") {
    symbols.push({ kind: "client", name: `${operation.name}Multipart` });
  }

  const valueSuffixes: string[] = [];
  const typeSuffixes: string[] = [];
  if (operation.parameters.path.length > 0) {
    valueSuffixes.push("PathSchema");
    typeSuffixes.push("Path");
  }
  if (operation.parameters.query.length > 0) {
    valueSuffixes.push("QuerySchema");
    typeSuffixes.push("Query");
  }
  if (operation.parameters.header.length > 0) {
    valueSuffixes.push("HeadersSchema");
    typeSuffixes.push("Headers");
  }
  if (operation.parameters.cookie.length > 0) {
    valueSuffixes.push("CookiesSchema");
    typeSuffixes.push("Cookies");
  }
  if (operation.requestBody) {
    valueSuffixes.push("FormSchema");
    typeSuffixes.push("Form");
  }
  if (
    operation.requestBody ||
    operation.parameters.query.length > 0 ||
    operation.parameters.header.length > 0 ||
    operation.parameters.cookie.length > 0
  ) {
    valueSuffixes.push("RequestSchema");
    typeSuffixes.push("RequestType");
  }
  const bodyResponses = operation.responses.filter((response) => response.body !== "empty");
  if (bodyResponses.length > 0) {
    valueSuffixes.push("Schema");
    typeSuffixes.push("Response");
  }
  symbols.push(
    ...valueSuffixes.map((suffix) => ({ kind: "schema value" as const, name: `${operation.name}${suffix}` })),
    ...typeSuffixes.map((suffix) => ({ kind: "schema type" as const, name: `${operation.typeName}${suffix}` })),
  );
  return symbols;
};

export const normalizeOpenApiDocument = (
  document: OpenAPIV3.Document,
  options: NormalizeOptions = {},
): NormalizedApi => {
  if (!document.openapi?.startsWith("3.0.")) {
    throw new Error(`Unsupported OpenAPI version ${document.openapi ?? "unknown"}; expected OpenAPI 3.0.x`);
  }

  const requestedPaths = options.paths ? new Set(options.paths) : undefined;
  if (requestedPaths) {
    const missing = [...requestedPaths].filter((path) => !(path in document.paths));
    if (missing.length > 0) throw new Error(`OpenAPI path(s) not found: ${missing.join(", ")}`);
  }
  const ignoreHeaders = new Set((options.ignoreHeaders ?? []).map((header) => header.toLowerCase()));
  const operations: NormalizedOperation[] = [];

  for (const [path, pathValue] of Object.entries(document.paths)) {
    if (requestedPaths && !requestedPaths.has(path)) continue;
    if (!pathValue) continue;
    if ("$ref" in pathValue) throw new Error(`${path}: unresolved path reference ${pathValue.$ref}`);
    for (const method of UNSUPPORTED_HTTP_METHODS) {
      if (pathValue[method]) {
        throw new Error(`${operationLabel(method, path)}: unsupported HTTP method`);
      }
    }
    for (const method of HTTP_METHODS) {
      const operation = pathValue[method];
      if (!operation) continue;
      const label = operationLabel(method, path);
      const name = makeOperationName(operation, method, path);
      const tag = operation.tags?.[0] ?? "default";
      const parameters = mergeParameters(pathValue.parameters, operation.parameters)
        .map((parameter) => normalizeParameter(parameter, label, ignoreHeaders))
        .filter((parameter): parameter is NormalizedParameter => parameter !== undefined);
      const byLocation = {
        path: parameters.filter((parameter) => parameter.location === "path"),
        query: parameters.filter((parameter) => parameter.location === "query"),
        header: parameters.filter((parameter) => parameter.location === "header"),
        cookie: parameters.filter((parameter) => parameter.location === "cookie"),
      };

      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const parameterNames = new Set(byLocation.path.map((parameter) => parameter.name));
      const missingParameters = placeholders.filter((name) => !parameterNames.has(name));
      if (missingParameters.length > 0) {
        throw new Error(`${label}: missing path parameter definition(s): ${missingParameters.join(", ")}`);
      }

      const requestBody = normalizeRequestBody(operation.requestBody, label);
      const argumentNames = byLocation.path.map((parameter) => parameter.argumentName);
      const duplicateArgument = argumentNames.find((name, index) => argumentNames.indexOf(name) !== index);
      if (duplicateArgument) {
        throw new Error(`${label}: multiple path parameters map to argument name ${duplicateArgument}`);
      }
      const hasRequestArgument = Boolean(
        requestBody || byLocation.query.length || byLocation.header.length || byLocation.cookie.length,
      );
      if (hasRequestArgument && argumentNames.includes("request")) {
        throw new Error(`${label}: path parameter maps to reserved request argument name`);
      }
      if (requestBody?.kind === "multipart" && argumentNames.includes("multipart")) {
        throw new Error(`${label}: path parameter maps to reserved multipart argument name`);
      }

      operations.push({
        method: method.toUpperCase() as HttpMethod,
        path,
        name,
        typeName: toPascalCase(name, `${method}Operation`),
        tag,
        parameters: byLocation,
        requestBody,
        responses: normalizeResponses(operation.responses, label),
      });
    }
  }

  const groupMap = new Map<string, { group: NormalizedGroup; symbols: Map<string, NormalizedOperation> }>();
  const reservedClientNames = new Set([
    "ActionBase",
    "APIRequestContext",
    "ApiClient",
    "ClientOptions",
    "MultipartPayload",
    "NonNullable",
    "Omit",
    "Promise",
    "ReturnType",
    "String",
  ]);
  for (const operation of operations) {
    const fileName = toCamelCase(operation.tag, "default");
    const clientName = toPascalCase(operation.tag, "Default");
    if (reservedClientNames.has(clientName)) {
      throw new Error(`Tag ${JSON.stringify(operation.tag)} maps to reserved client name ${clientName}`);
    }
    const existing = groupMap.get(fileName);
    if (existing && existing.group.tag !== operation.tag) {
      throw new Error(
        `Tags ${JSON.stringify(existing.group.tag)} and ${JSON.stringify(operation.tag)} map to the same file ${fileName}.ts`,
      );
    }
    const state = existing ?? {
      group: {
        tag: operation.tag,
        fileName,
        clientName,
        operations: [],
      },
      symbols: new Map<string, NormalizedOperation>(),
    };
    const symbols = generatedSymbols(operation);
    const reservedMembers = new Set(["constructor", "context", "get", "post", "put", "patch", "delete", "validateRequest"]);
    const reservedName = symbols
      .filter((symbol) => symbol.kind === "client")
      .find((symbol) => reservedMembers.has(symbol.name))?.name;
    if (reservedName) {
      throw new Error(
        `${operation.method} ${operation.path}: operation maps to reserved client member ${reservedName}`,
      );
    }
    for (const symbol of symbols) {
      const key = `${symbol.kind}:${symbol.name}`;
      const collision = state.symbols.get(key);
      if (!collision) continue;
      const collisionKind = symbol.kind === "client" ? "Operation name" : `Generated ${symbol.kind}`;
      throw new Error(
        `${collisionKind} collision in tag ${operation.tag}: ${collision.method} ${collision.path} and ${operation.method} ${operation.path} both generate ${symbol.name}`,
      );
    }
    for (const symbol of symbols) state.symbols.set(`${symbol.kind}:${symbol.name}`, operation);
    state.group.operations.push(operation);
    groupMap.set(fileName, state);
  }

  const groups = [...groupMap.values()]
    .map(({ group }) => group)
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  const rootExports = new Map<string, string>();
  for (const group of groups) {
    for (const name of [group.clientName, `${group.clientName}Schema`]) {
      const existingTag = rootExports.get(name);
      if (existingTag) {
        throw new Error(
          `Tags ${JSON.stringify(existingTag)} and ${JSON.stringify(group.tag)} both export ${name}`,
        );
      }
      rootExports.set(name, group.tag);
    }
  }

  return {
    inputHash: createHash("sha256").update(JSON.stringify(document)).digest("hex"),
    groups,
  };
};

export const loadOpenApi = async (source: string, options: NormalizeOptions = {}): Promise<NormalizedApi> => {
  const document = (await SwaggerParser.dereference(source, {
    dereference: { circular: false },
    resolve: { http: false },
  })) as OpenAPIV3.Document;
  return normalizeOpenApiDocument(document, options);
};
