import { parseArgs } from "node:util";

import { resolveConfig } from "../config/index.js";
import type { CliConfigOverrides } from "../config/types.js";
import { GENERATOR_VERSION, generate } from "../generator/index.js";
import type { GenerationResult, GeneratorOptions } from "../generator/index.js";

export const HELP_TEXT = `Usage: zod-api-client generate [api-document] [options]

Generate Zod schemas and typed API clients from an API document (OpenAPI 3.0/3.1, Swagger 2.0, Postman collection, HAR, file or URL).

Options:
  -c, --config <file>          Use an explicit config file
  -o, --output <directory>     Set the generated output directory
      --path <api-path>        Generate one API path (repeatable)
      --ignore-header <name>   Omit one request header (repeatable)
      --lenient                Skip unsupported operations instead of failing
  -h, --help                   Show this help
  -v, --version                Show the package version
`;

interface OutputWriter {
  write(chunk: string): unknown;
}

interface CliDependencies {
  cwd?: string;
  generate?: (options: GeneratorOptions) => Promise<GenerationResult>;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
}

export const parseCliArguments = (
  args: string[],
): {
  command?: string;
  overrides: CliConfigOverrides;
  help: boolean;
  version: boolean;
} => {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      output: { type: "string", short: "o" },
      path: { type: "string", multiple: true },
      "ignore-header": { type: "string", multiple: true },
      lenient: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  const scalarOption = (name: "config" | "output"): string | undefined => {
    const value = parsed.values[name];
    if (value === "") {
      throw new Error(`Option --${name} requires a value`);
    }
    return value as string | undefined;
  };
  const multipleOption = (name: "path" | "ignore-header"): string[] | undefined => {
    const values = parsed.values[name] as string[] | undefined;
    if (values?.some((value) => value === "")) {
      throw new Error(`Option --${name} requires a value`);
    }
    return values;
  };
  if (parsed.positionals.length > 2) {
    throw new Error(`Unexpected argument: ${parsed.positionals[2]}`);
  }

  const config = scalarOption("config");
  const output = scalarOption("output");
  const paths = multipleOption("path");
  const ignoreHeaders = multipleOption("ignore-header");

  return {
    command: parsed.positionals[0],
    overrides: {
      ...(parsed.positionals[1] === undefined ? {} : { input: parsed.positionals[1] }),
      ...(config === undefined ? {} : { config }),
      ...(output === undefined ? {} : { output }),
      ...(paths === undefined ? {} : { paths }),
      ...(ignoreHeaders === undefined ? {} : { ignoreHeaders }),
      ...(parsed.values.lenient === true ? { strict: false } : {}),
    },
    help: parsed.values.help === true,
    version: parsed.values.version === true,
  };
};

export const runCli = async (args: string[], dependencies: CliDependencies = {}): Promise<number> => {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  try {
    const parsed = parseCliArguments(args);
    if (parsed.version) {
      stdout.write(`${GENERATOR_VERSION}\n`);
      return 0;
    }
    if (parsed.help) {
      stdout.write(HELP_TEXT);
      return 0;
    }
    if (parsed.command !== "generate") {
      const detail = parsed.command ? `Unknown command: ${parsed.command}` : "Missing command";
      throw new Error(`${detail}. Run zod-api-client --help for usage.`);
    }

    const config = await resolveConfig({
      cwd: dependencies.cwd,
      overrides: parsed.overrides,
    });
    const generateClient = dependencies.generate ?? generate;
    const result = await generateClient(config);
    for (const { operation, reason } of result.skipped) {
      stderr.write(`Skipped ${operation}: ${reason}\n`);
    }
    const skippedNote = result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : "";
    stdout.write(`Generated ${result.operationCount} operations in ${config.output}${skippedNote}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Error: ${message}\n`);
    return 1;
  }
};
