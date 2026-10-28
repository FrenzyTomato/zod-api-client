import type { NormalizedApi, NormalizedOperation, NormalizedParameter } from "../openapi/index.js";
import { renderZodSchema } from "./schema-expression.js";

export interface RenderedFile {
  path: string;
  content: string;
}

const renderParameterObject = (
  parameters: NormalizedParameter[],
  operation: NormalizedOperation,
  suffix: string,
): string => {
  const properties = parameters.map((parameter) => {
    let expression = renderZodSchema(
      parameter.schema,
      `${operation.method} ${operation.path} ${parameter.location} parameter ${parameter.name}`,
    );
    if (!parameter.required) expression += ".optional()";
    return `${JSON.stringify(parameter.name)}: ${expression}`;
  });
  return `export const ${operation.name}${suffix}Schema = z.object({${properties.join(", ")}});`;
};

const hasRequest = (operation: NormalizedOperation): boolean =>
  Boolean(
    operation.requestBody ||
      operation.parameters.query.length ||
      operation.parameters.header.length ||
      operation.parameters.cookie.length,
  );

const renderOperation = (operation: NormalizedOperation): string => {
  const output: string[] = [];
  if (operation.parameters.path.length > 0) {
    output.push(renderParameterObject(operation.parameters.path, operation, "Path"));
    output.push(`export type ${operation.typeName}Path = z.infer<typeof ${operation.name}PathSchema>;`);
  }
  if (operation.parameters.query.length > 0) {
    output.push(renderParameterObject(operation.parameters.query, operation, "Query"));
    output.push(`export type ${operation.typeName}Query = z.infer<typeof ${operation.name}QuerySchema>;`);
  }
  if (operation.parameters.header.length > 0) {
    output.push(renderParameterObject(operation.parameters.header, operation, "Headers"));
    output.push(`export type ${operation.typeName}Headers = z.infer<typeof ${operation.name}HeadersSchema>;`);
  }
  if (operation.parameters.cookie.length > 0) {
    output.push(renderParameterObject(operation.parameters.cookie, operation, "Cookies"));
    output.push(`export type ${operation.typeName}Cookies = z.infer<typeof ${operation.name}CookiesSchema>;`);
  }
  if (operation.requestBody) {
    output.push(
      `export const ${operation.name}FormSchema = ${renderZodSchema(operation.requestBody.schema, `${operation.method} ${operation.path} request body`, { binaryAsFile: operation.requestBody.kind === "multipart" })};`,
    );
    output.push(`export type ${operation.typeName}Form = z.infer<typeof ${operation.name}FormSchema>;`);
  }
  if (hasRequest(operation)) {
    const requestProperties: string[] = [];
    if (operation.parameters.query.length > 0) {
      const required = operation.parameters.query.some((parameter) => parameter.required);
      requestProperties.push(`query: ${operation.name}QuerySchema${required ? "" : ".optional()"}`);
    }
    if (operation.parameters.header.length > 0) {
      const required = operation.parameters.header.some((parameter) => parameter.required);
      requestProperties.push(`headers: ${operation.name}HeadersSchema${required ? "" : ".optional()"}`);
    }
    if (operation.parameters.cookie.length > 0) {
      const required = operation.parameters.cookie.some((parameter) => parameter.required);
      requestProperties.push(`cookies: ${operation.name}CookiesSchema${required ? "" : ".optional()"}`);
    }
    if (operation.requestBody) {
      requestProperties.push(
        `body: ${operation.name}FormSchema${operation.requestBody.required ? "" : ".optional()"}`,
      );
    }
    output.push(`export const ${operation.name}RequestSchema = z.object({${requestProperties.join(", ")}});`);
    output.push(`export type ${operation.typeName}RequestType = z.infer<typeof ${operation.name}RequestSchema>;`);
  }

  const bodyResponses = operation.responses.filter((response) => response.body !== "empty");
  if (bodyResponses.length > 0) {
    const schemas = bodyResponses.map((response) =>
      renderZodSchema(
        response.schema ?? {},
        `${operation.method} ${operation.path} response ${response.status}${response.mediaType ? ` ${response.mediaType}` : ""}`,
      ),
    );
    if (operation.responses.some((response) => response.body === "empty")) schemas.push("z.undefined()");
    const expression = schemas.length === 1 ? schemas[0] : `z.union([${schemas.join(", ")}])`;
    output.push(`export const ${operation.name}Schema = ${expression};`);
    output.push(`export type ${operation.typeName}Response = z.infer<typeof ${operation.name}Schema>;`);
  }
  return output.join("\n");
};

export const renderSchemaFiles = (api: NormalizedApi): RenderedFile[] =>
  api.groups.map((group) => {
    const body = group.operations.map(renderOperation).join("\n\n");
    const uploadImport = body.includes("z.custom<UploadFile>") ? 'import type { UploadFile } from "zod-api-client/runtime";\n' : "";
    return {
      path: `schemas/${group.fileName}.ts`,
      content: `import { z } from "zod";\n${uploadImport}\nexport namespace ${group.clientName}Schema {\n${body}\n}\n`,
    };
  });
