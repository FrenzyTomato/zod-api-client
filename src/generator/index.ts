import path from "node:path";
import { loadInput } from "../inputs/index.js";
import { formatRenderedFiles, writeGeneratedOutput } from "./output.js";
import { renderClientFiles } from "./render-clients.js";
import { renderIndexFile } from "./render-index.js";
import { renderSchemaFiles } from "./render-schemas.js";

export interface GeneratorOptions {
  input: string;
  output?: string;
  paths?: string[];
  ignoreHeaders?: string[];
  strict?: boolean;
  har?: { hosts?: string[] };
}

export interface GenerationResult {
  input: string;
  output: string;
  inputHash: string;
  operationCount: number;
  files: string[];
  skipped: Array<{ operation: string; reason: string }>;
}

export const GENERATOR_VERSION = "0.3.0";

export const generate = async (options: GeneratorOptions): Promise<GenerationResult> => {
  const input = /^https?:\/\//i.test(options.input) ? options.input : path.resolve(options.input);
  const output = path.resolve(options.output ?? "generated-api");
  const { api, skipped } = await loadInput(input, {
    paths: options.paths,
    ignoreHeaders: options.ignoreHeaders,
    strict: options.strict,
    har: options.har,
  });
  const inputHash = api.inputHash;
  const files = await formatRenderedFiles([...renderSchemaFiles(api), ...renderClientFiles(api), renderIndexFile(api)]);
  const marker = await writeGeneratedOutput(output, files, {
    generator: "zod-api-client",
    version: GENERATOR_VERSION,
    inputHash,
  });
  return {
    input,
    output,
    inputHash,
    operationCount: api.groups.reduce((count, group) => count + group.operations.length, 0),
    files: marker.ownedFiles,
    skipped,
  };
};

export { renderClientFiles } from "./render-clients.js";
export { renderIndexFile } from "./render-index.js";
export { renderSchemaFiles } from "./render-schemas.js";
export { renderZodSchema } from "./schema-expression.js";
export type { RenderedFile } from "./render-schemas.js";
