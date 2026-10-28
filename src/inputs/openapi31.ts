import { Converter } from "@apiture/openapi-down-convert";
import type { OpenAPIV3 } from "openapi-types";

type Json = Record<string, any>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

const downConvertSchema = (schema: Json): void => {
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type: string) => type !== "null");
    if (types.length < schema.type.length) schema.nullable = true;
    if (types.length === 1) schema.type = types[0];
    else if (types.length === 0) delete schema.type;
    else {
      schema.oneOf = types.map((type: string) => ({ type }));
      delete schema.type;
    }
  }
  if ("const" in schema) {
    schema.enum = [schema.const];
    delete schema.const;
  }
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof schema[key] === "number") {
      schema[bound] = schema[key];
      schema[key] = true;
    }
  }
  if (Array.isArray(schema.examples)) {
    schema.example = schema.examples[0];
    delete schema.examples;
  }
  delete schema.$schema;
  delete schema.$id;
};

const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_VALUES = ["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"];

const walkSchema = (schema: unknown): void => {
  if (!isObject(schema)) return;
  downConvertSchema(schema);
  for (const key of SCHEMA_MAPS) {
    if (isObject(schema[key])) Object.values(schema[key]).forEach(walkSchema);
  }
  for (const key of SCHEMA_LISTS) {
    if (Array.isArray(schema[key])) schema[key].forEach(walkSchema);
  }
  for (const key of SCHEMA_VALUES) walkSchema(schema[key]);
};

const walkContent = (content: unknown): void => {
  if (isObject(content)) Object.values(content).forEach((media) => walkSchema(isObject(media) ? media.schema : undefined));
};

const walkParameters = (parameters: unknown): void => {
  if (!Array.isArray(parameters)) return;
  for (const parameter of parameters) {
    if (!isObject(parameter)) continue;
    walkSchema(parameter.schema);
    walkContent(parameter.content);
  }
};

const downConvert = (document: Json): OpenAPIV3.Document => {
  const copy = structuredClone(document);
  delete copy.webhooks;
  delete copy.jsonSchemaDialect;
  copy.openapi = "3.0.3";
  const components = isObject(copy.components) ? copy.components : {};
  Object.values<unknown>(isObject(components.schemas) ? components.schemas : {}).forEach(walkSchema);
  for (const group of ["parameters", "headers"]) {
    for (const value of Object.values<unknown>(isObject(components[group]) ? components[group] : {})) {
      if (isObject(value)) walkSchema(value.schema);
    }
  }
  for (const value of Object.values<unknown>(isObject(components.requestBodies) ? components.requestBodies : {})) {
    if (isObject(value)) walkContent(value.content);
  }
  for (const value of Object.values<unknown>(isObject(components.responses) ? components.responses : {})) {
    if (isObject(value)) walkContent(value.content);
  }
  for (const pathItem of Object.values<unknown>(isObject(copy.paths) ? copy.paths : {})) {
    if (!isObject(pathItem)) continue;
    walkParameters(pathItem.parameters);
    for (const operation of Object.values<unknown>(pathItem)) {
      if (!isObject(operation)) continue;
      walkParameters(operation.parameters);
      if (isObject(operation.requestBody)) walkContent(operation.requestBody.content);
      for (const response of Object.values<unknown>(isObject(operation.responses) ? operation.responses : {})) {
        if (isObject(response)) walkContent(response.content);
      }
    }
  }
  return copy as OpenAPIV3.Document;
};

export const convertOpenApi31 = (document: object): OpenAPIV3.Document => {
  let converted: Json = document;
  try {
    converted = new Converter(document, {}).convert();
  } catch {}
  // The library leaves numeric exclusiveMinimum/Maximum in place; this pass is idempotent for the rest.
  return downConvert(converted);
};
