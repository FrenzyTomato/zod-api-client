import type { NormalizedApi, NormalizedGroup, NormalizedOperation } from "../openapi/index.js";
import type { RenderedFile } from "./render-schemas.js";

const operationHasRequest = (operation: NormalizedOperation): boolean =>
  Boolean(
    operation.requestBody ||
      operation.parameters.query.length ||
      operation.parameters.header.length ||
      operation.parameters.cookie.length,
  );

const operationRequestIsRequired = (operation: NormalizedOperation): boolean =>
  Boolean(
    operation.requestBody?.required ||
    operation.parameters.query.some((parameter) => parameter.required) ||
    operation.parameters.header.some((parameter) => parameter.required) ||
    operation.parameters.cookie.some((parameter) => parameter.required),
  );

const operationReturnType = (operation: NormalizedOperation, namespace: string): string => {
  const hasBody = operation.responses.some((response) => response.body !== "empty");
  const hasEmpty = operation.responses.some((response) => response.body === "empty");
  if (!hasBody) return "void";
  return `${namespace}.${operation.typeName}Response${hasEmpty ? " | void" : ""}`;
};

const renderUrl = (operation: NormalizedOperation): string => {
  const parameters = new Map(operation.parameters.path.map((parameter) => [parameter.name, parameter.argumentName]));
  const pattern = /\{([^}]+)\}/g;
  let result = "";
  let cursor = 0;
  for (const match of operation.path.matchAll(pattern)) {
    const index = match.index ?? 0;
    result += operation.path.slice(cursor, index).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    const argument = parameters.get(match[1]);
    if (!argument) throw new Error(`${operation.method} ${operation.path}: path parameter ${match[1]} is missing`);
    result += `\${pathSegment(${argument})}`;
    cursor = index + match[0].length;
  }
  result += operation.path.slice(cursor).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `\`${result}\``;
};

const renderPathArguments = (operation: NormalizedOperation, namespace: string): string[] =>
  operation.parameters.path.map(
    (parameter) =>
      `${parameter.argumentName}: ${namespace}.${operation.typeName}Path[${JSON.stringify(parameter.name)}]`,
  );

const renderRequestValidation = (
  operation: NormalizedOperation,
  namespace: string,
  hasRequest: boolean,
  requestRequired: boolean,
): string[] => {
  const statements: string[] = [];
  if (operation.parameters.path.length > 0) {
    const value = operation.parameters.path
      .map((parameter) => `${JSON.stringify(parameter.name)}: ${parameter.argumentName}`)
      .join(", ");
    statements.push(`this.validateRequest(${namespace}.${operation.name}PathSchema, { ${value} });`);
  }

  if (hasRequest) {
    const statement = `this.validateRequest(${namespace}.${operation.name}RequestSchema, request);`;
    statements.push(requestRequired ? statement : `if (request !== undefined) ${statement}`);
  }

  return statements;
};

const renderRequestOptions = (operation: NormalizedOperation): string[] => {
  const fields: string[] = [];
  if (operation.parameters.query.length > 0) {
    fields.push("params: request?.query");
  }
  if (operation.parameters.header.length > 0) {
    fields.push("headers: request?.headers");
  }
  if (operation.parameters.cookie.length > 0) {
    fields.push("cookies: request?.cookies");
  }
  if (operation.requestBody) {
    if (operation.requestBody.kind === "multipart") {
      fields.push("multipart: request?.body === undefined ? undefined : toMultipartForm(request.body)");
    } else if (operation.requestBody.kind === "data") {
      fields.push("data: request?.body");
    } else {
      fields.push("form: request?.body");
    }
  }
  return fields;
};

const renderMethod = (operation: NormalizedOperation, group: NormalizedGroup): string => {
  const namespace = `${group.clientName}Schema`;
  const argumentsList = renderPathArguments(operation, namespace);
  const hasRequest = operationHasRequest(operation);
  const requestRequired = operationRequestIsRequired(operation);

  if (hasRequest) {
    argumentsList.push(`request${requestRequired ? "" : "?"}: ${namespace}.${operation.typeName}RequestType`);
  }

  const validation = renderRequestValidation(operation, namespace, hasRequest, requestRequired);
  const options = renderRequestOptions(operation);
  const hasBody = operation.responses.some((response) => response.body !== "empty");
  if (hasBody) options.push(`responseSchema: ${namespace}.${operation.name}Schema`);
  const optionsArgument = options.length > 0 ? `, { ${options.join(", ")} }` : "";
  const requestCall = `this.${operation.method.toLowerCase()}($url${optionsArgument})`;
  const response = hasBody ? [`return ${requestCall};`] : [`await ${requestCall};`];

  return `public async ${operation.name}(${argumentsList.join(", ")}): Promise<${operationReturnType(operation, namespace)}> {
  ${[...validation, `const $url = ${renderUrl(operation)};`, ...response].join("\n  ")}
}`;
};

export const renderClientFiles = (api: NormalizedApi): RenderedFile[] =>
  api.groups.map((group) => {
    const hasMultipart = group.operations.some((operation) => operation.requestBody?.kind === "multipart");
    const hasPath = group.operations.some((operation) => operation.parameters.path.length > 0);
    const values = ["ActionBase", ...(hasPath ? ["pathSegment"] : []), ...(hasMultipart ? ["toMultipartForm"] : [])].join(", ");
    const methods = group.operations.map((operation) => renderMethod(operation, group));

    return {
      path: `clients/${group.fileName}.ts`,
      content: `import { ${values} } from "zod-api-client/runtime";
import { ${group.clientName}Schema } from "../schemas/${group.fileName}.js";

export class ${group.clientName} extends ActionBase {
${methods.join("\n\n")}
}
`,
    };
  });
