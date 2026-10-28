import type { OpenAPIV3 } from "openapi-types";

const kindOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

export const inferSchema = (samples: unknown[]): OpenAPIV3.SchemaObject => {
  const present = samples.filter((sample) => sample !== undefined);
  const nullable = present.some((sample) => sample === null);
  const values = present.filter((sample) => sample !== null);
  if (values.length === 0) return nullable ? { nullable: true } : {};

  const kinds = [...new Set(values.map(kindOf))];
  const groups = (kinds.includes("integer") && kinds.includes("number")
    ? kinds.filter((kind) => kind !== "integer")
    : kinds
  ).map((kind): OpenAPIV3.SchemaObject => {
    const matching = values.filter((value) => (kind === "number" ? typeof value === "number" : kindOf(value) === kind));
    if (kind === "array") {
      return { type: "array", items: inferSchema(matching.flat() as unknown[]) };
    }
    if (kind === "object") {
      const objects = matching as Array<Record<string, unknown>>;
      const keys = [...new Set(objects.flatMap((object) => Object.keys(object)))];
      const required = keys.filter((key) => objects.every((object) => object[key] !== undefined));
      return {
        type: "object",
        properties: Object.fromEntries(keys.map((key) => [key, inferSchema(objects.map((object) => object[key]))])),
        ...(required.length > 0 ? { required } : {}),
      };
    }
    return { type: kind as OpenAPIV3.NonArraySchemaObjectType };
  });

  const schema: OpenAPIV3.SchemaObject = groups.length === 1 ? groups[0] : { oneOf: groups };
  return nullable ? { ...schema, nullable: true } : schema;
};
