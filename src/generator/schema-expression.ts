import type { OpenAPIV3 } from "openapi-types";

interface RenderedSchema {
  expression: string;
  unconstrained: boolean;
}

const unknownSchema = (): RenderedSchema => ({
  expression: "z.unknown()",
  unconstrained: true,
});

const referencedSchema = (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
  location: string,
): OpenAPIV3.SchemaObject => {
  if ("$ref" in schema) throw new Error(`${location}: unresolved schema reference ${schema.$ref}`);
  return schema;
};

const withNullable = (rendered: RenderedSchema, schema: OpenAPIV3.SchemaObject): RenderedSchema =>
  schema.nullable && !rendered.unconstrained
    ? { ...rendered, expression: `${rendered.expression}.nullable()` }
    : rendered;

const unique = (schemas: RenderedSchema[]): RenderedSchema[] => {
  const expressions = new Set<string>();
  return schemas.filter((schema) => {
    if (expressions.has(schema.expression)) return false;
    expressions.add(schema.expression);
    return true;
  });
};

const renderUnion = (schemas: RenderedSchema[]): RenderedSchema => {
  if (schemas.some((schema) => schema.unconstrained)) return unknownSchema();
  const members = unique(schemas);
  if (members.length === 1) return members[0];
  return {
    expression: `z.union([${members.map((schema) => schema.expression).join(", ")}])`,
    unconstrained: false,
  };
};

const renderIntersection = (schemas: RenderedSchema[]): RenderedSchema => {
  const members = unique(schemas.filter((schema) => !schema.unconstrained));
  if (members.length === 0) return unknownSchema();
  if (members.length === 1) return members[0];
  return {
    expression: members
      .slice(1)
      .reduce((left, right) => `z.intersection(${left}, ${right.expression})`, members[0].expression),
    unconstrained: false,
  };
};

const renderConstant = (value: unknown, location: string): string => {
  if (value === null) return "z.null()";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `z.literal(${JSON.stringify(value)})`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "z.array(z.never()).length(0)";
    return `z.tuple([${value.map((item, index) => renderConstant(item, `${location}[${index}]`)).join(", ")}])`;
  }
  if (typeof value === "object") {
    const properties = Object.entries(value).map(
      ([name, property]) => `${JSON.stringify(name)}: ${renderConstant(property, `${location}.${name}`)}`,
    );
    return `z.object({${properties.join(", ")}}).strict()`;
  }
  throw new Error(`${location}: enum contains unsupported value ${String(value)}`);
};

export interface RenderOptions {
  binaryAsFile?: boolean;
}

const renderEnum = (values: unknown[], location: string): RenderedSchema => {
  if (values.length === 0) throw new Error(`${location}: enum must contain at least one value`);
  const literals = [...new Set(values.map((value, index) => renderConstant(value, `${location}[${index}]`)))];
  return {
    expression: literals.length === 1 ? literals[0] : `z.union([${literals.join(", ")}])`,
    unconstrained: false,
  };
};

const renderString = (schema: OpenAPIV3.SchemaObject): string => {
  let expression = "z.string()";
  if (schema.minLength !== undefined) expression += `.min(${schema.minLength})`;
  if (schema.maxLength !== undefined) expression += `.max(${schema.maxLength})`;
  if (schema.pattern !== undefined) expression += `.regex(new RegExp(${JSON.stringify(schema.pattern)}))`;
  switch (schema.format) {
    case "email":
      expression += ".email()";
      break;
    case "uri":
    case "url":
      expression += ".url()";
      break;
    case "uuid":
      expression += ".uuid()";
      break;
    case "date":
      expression += String.raw`.regex(/^\d{4}-\d{2}-\d{2}$/)`;
      break;
    case "date-time":
      expression += ".datetime({ offset: true })";
      break;
  }
  return expression;
};

const renderNumber = (schema: OpenAPIV3.SchemaObject, integer: boolean): string => {
  let expression = integer ? "z.number().int()" : "z.number()";
  if (schema.minimum !== undefined) {
    expression += schema.exclusiveMinimum ? `.gt(${schema.minimum})` : `.min(${schema.minimum})`;
  }
  if (schema.maximum !== undefined) {
    expression += schema.exclusiveMaximum ? `.lt(${schema.maximum})` : `.max(${schema.maximum})`;
  }
  if (schema.multipleOf !== undefined) expression += `.multipleOf(${schema.multipleOf})`;
  return expression;
};

const inferSchemaType = (schema: OpenAPIV3.SchemaObject, location: string): string | undefined => {
  if (schema.type) return schema.type;

  const inferred = new Set<string>();
  if (
    schema.properties ||
    schema.required ||
    schema.additionalProperties !== undefined ||
    schema.minProperties !== undefined ||
    schema.maxProperties !== undefined
  ) {
    inferred.add("object");
  }
  if (
    ("items" in schema && schema.items !== undefined) ||
    schema.minItems !== undefined ||
    schema.maxItems !== undefined ||
    schema.uniqueItems !== undefined
  ) {
    inferred.add("array");
  }
  if (schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern !== undefined) {
    inferred.add("string");
  }
  if (
    schema.minimum !== undefined ||
    schema.maximum !== undefined ||
    schema.exclusiveMinimum !== undefined ||
    schema.exclusiveMaximum !== undefined ||
    schema.multipleOf !== undefined
  ) {
    inferred.add("number");
  }
  if (schema.format) {
    if (["int32", "int64", "float", "double"].includes(schema.format)) inferred.add("number");
    else if (
      ["byte", "binary", "date", "date-time", "password", "email", "uuid", "uri", "url"].includes(schema.format)
    ) {
      inferred.add("string");
    } else {
      throw new Error(`${location}: schema format ${schema.format} requires an explicit type`);
    }
  }

  if (inferred.size > 1) throw new Error(`${location}: schema constraints require an explicit type`);
  return inferred.values().next().value as string | undefined;
};

const requiredValue = (expression?: string): string => {
  const required = 'z.custom<{} | null>((value) => value !== undefined, "Required value is missing")';
  return expression ? `z.intersection(${required}, ${expression})` : required;
};

const renderObject = (
  schema: OpenAPIV3.NonArraySchemaObject,
  location: string,
  stack: Set<OpenAPIV3.SchemaObject>,
  options: RenderOptions,
): string => {
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const rendered = renderSchemaInternal(
      referencedSchema(property, `${location}.properties.${name}`),
      `${location}.properties.${name}`,
      stack,
      options,
    );
    const expression = !required.has(name)
      ? `${rendered.expression}.optional()`
      : rendered.unconstrained
        ? requiredValue()
        : rendered.expression;
    return `${JSON.stringify(name)}: ${expression}`;
  });
  for (const name of required) {
    if (!(name in (schema.properties ?? {}))) properties.push(`${JSON.stringify(name)}: ${requiredValue()}`);
  }

  let expression = `z.object({${properties.join(", ")}})`;
  if (schema.additionalProperties === false) {
    expression += ".strict()";
  } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const additional = referencedSchema(schema.additionalProperties, `${location}.additionalProperties`);
    expression += `.catchall(${renderSchemaInternal(additional, `${location}.additionalProperties`, stack, options).expression})`;
  } else {
    expression += ".passthrough()";
  }
  if (schema.minProperties !== undefined) {
    expression += `.refine((value) => Object.keys(value).length >= ${schema.minProperties}, "Object has too few properties")`;
  }
  if (schema.maxProperties !== undefined) {
    expression += `.refine((value) => Object.keys(value).length <= ${schema.maxProperties}, "Object has too many properties")`;
  }
  return expression;
};

const renderArray = (
  schema: OpenAPIV3.ArraySchemaObject,
  location: string,
  stack: Set<OpenAPIV3.SchemaObject>,
  options: RenderOptions,
): string => {
  const items = schema.items
    ? renderSchemaInternal(referencedSchema(schema.items, `${location}.items`), `${location}.items`, stack, options).expression
    : "z.unknown()";
  let expression = `z.array(${items})`;
  if (schema.minItems !== undefined) expression += `.min(${schema.minItems})`;
  if (schema.maxItems !== undefined) expression += `.max(${schema.maxItems})`;
  if (schema.uniqueItems) {
    expression += `.refine((items) => new Set(items.map((item) => JSON.stringify(item))).size === items.length, "Array items must be unique")`;
  }
  return expression;
};

const renderComposition = (
  schema: OpenAPIV3.SchemaObject,
  location: string,
  stack: Set<OpenAPIV3.SchemaObject>,
  options: RenderOptions,
): RenderedSchema | undefined => {
  const parts: RenderedSchema[] = [];
  const renderMembers = (
    schemas: Array<OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject>,
    keyword: "oneOf" | "anyOf" | "allOf",
  ): RenderedSchema[] => {
    if (schemas.length === 0) throw new Error(`${location}.${keyword}: ${keyword} must contain at least one schema`);
    return schemas.map((member, index) =>
      renderSchemaInternal(
        referencedSchema(member, `${location}.${keyword}[${index}]`),
        `${location}.${keyword}[${index}]`,
        stack,
        options,
      ),
    );
  };

  if (schema.oneOf) parts.push(renderUnion(renderMembers(schema.oneOf, "oneOf")));
  if (schema.anyOf) parts.push(renderUnion(renderMembers(schema.anyOf, "anyOf")));
  if (schema.allOf) parts.push(renderIntersection(renderMembers(schema.allOf, "allOf")));
  if (parts.length === 0) return undefined;

  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, nullable: _nullable, ...sibling } = schema;
  parts.push(renderSchemaInternal(sibling as OpenAPIV3.SchemaObject, `${location}.siblingConstraints`, stack, options));
  return renderIntersection(parts);
};

const renderSchemaInternal = (
  schema: OpenAPIV3.SchemaObject,
  location: string,
  stack: Set<OpenAPIV3.SchemaObject>,
  options: RenderOptions,
): RenderedSchema => {
  if (stack.has(schema)) throw new Error(`${location}: circular schemas are not supported`);
  stack.add(schema);
  try {
    if (schema.not) throw new Error(`${location}: not schemas are not supported`);

    const composition = renderComposition(schema, location, stack, options);
    if (composition) return withNullable(composition, schema);
    if (schema.enum) return withNullable(renderEnum(schema.enum, `${location}.enum`), schema);

    const type = inferSchemaType(schema, location);
    let expression: string;
    switch (type) {
      case "string":
        expression = options.binaryAsFile && schema.format === "binary" ? "z.custom<UploadFile>()" : renderString(schema);
        break;
      case "number":
        expression = renderNumber(schema, false);
        break;
      case "integer":
        expression = renderNumber(schema, true);
        break;
      case "boolean":
        expression = "z.boolean()";
        break;
      case "null":
        expression = "z.null()";
        break;
      case "array":
        expression = renderArray(schema as OpenAPIV3.ArraySchemaObject, location, stack, options);
        break;
      case "object":
        expression = renderObject(schema as OpenAPIV3.NonArraySchemaObject, location, stack, options);
        break;
      case undefined:
        return unknownSchema();
      default:
        throw new Error(`${location}: unsupported schema type ${String(type)}`);
    }
    return withNullable({ expression, unconstrained: false }, schema);
  } finally {
    stack.delete(schema);
  }
};

export const renderZodSchema = (
  schema: OpenAPIV3.SchemaObject,
  location = "schema",
  options: RenderOptions = {},
): string => renderSchemaInternal(schema, location, new Set(), options).expression;
