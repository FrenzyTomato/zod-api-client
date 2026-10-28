import type { OpenAPIV3 } from "openapi-types";
import { normalizeOpenApiDocument } from "../openapi/index.js";

export interface SkippedOperation {
  operation: string;
  reason: string;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const UNSUPPORTED_METHODS = ["head", "options", "trace"] as const;

export const filterUnsupportedOperations = (
  document: OpenAPIV3.Document,
  options: { paths?: string[]; ignoreHeaders?: string[] },
): SkippedOperation[] => {
  const skipped: SkippedOperation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || (options.paths && !options.paths.includes(path))) continue;
    const item = pathItem as Record<string, any>;
    for (const method of UNSUPPORTED_METHODS) {
      if (!item[method]) continue;
      delete item[method];
      skipped.push({ operation: `${method.toUpperCase()} ${path}`, reason: "unsupported HTTP method" });
    }
    for (const method of METHODS) {
      if (!item[method]) continue;
      const copy = {
        ...document,
        paths: { [path]: { ...(item.parameters ? { parameters: item.parameters } : {}), [method]: item[method] } },
      } as OpenAPIV3.Document;
      try {
        normalizeOpenApiDocument(copy, { ignoreHeaders: options.ignoreHeaders });
      } catch (error) {
        delete item[method];
        skipped.push({
          operation: `${method.toUpperCase()} ${path}`,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!METHODS.some((method) => item[method])) delete document.paths[path];
  }
  return skipped;
};
