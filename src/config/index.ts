import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createJiti } from "jiti";

import type { CliConfigOverrides, ResolvedConfig, ZodClientGeneratorConfig } from "./types.js";

export const CONFIG_FILE_NAME = "zod-api-client.config.ts";

export class ConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

interface LoadedConfig {
  config: ZodClientGeneratorConfig;
  path?: string;
}

const sourceName = (sourcePath?: string): string => sourcePath ?? "configuration";

const stringValue = (value: unknown, field: string, sourcePath?: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`${sourceName(sourcePath)}: field "${field}" must be a non-empty string`);
  }
  return value;
};

const stringArray = (value: unknown, field: string, sourcePath?: string): string[] => {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${sourceName(sourcePath)}: field "${field}" must be an array of strings`);
  }
  return value.map((item, index) => stringValue(item, `${field}[${index}]`, sourcePath));
};

const booleanValue = (value: unknown, field: string, sourcePath?: string): boolean => {
  if (typeof value !== "boolean") {
    throw new ConfigurationError(`${sourceName(sourcePath)}: field "${field}" must be a boolean`);
  }
  return value;
};

const validateHar = (value: unknown, sourcePath?: string): { hosts?: string[] } => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${sourceName(sourcePath)}: field "har" must be an object`);
  }
  const har = value as Record<string, unknown>;
  for (const key of Object.keys(har)) {
    if (key !== "hosts") {
      throw new ConfigurationError(`${sourceName(sourcePath)}: unknown field "har.${key}"`);
    }
  }
  return har.hosts === undefined ? {} : { hosts: stringArray(har.hosts, "har.hosts", sourcePath) };
};

const validateConfig = (value: unknown, sourcePath?: string): ZodClientGeneratorConfig => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${sourceName(sourcePath)}: default export must be a configuration object`);
  }

  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(["input", "output", "paths", "ignoreHeaders", "strict", "har"]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new ConfigurationError(`${sourceName(sourcePath)}: unknown configuration field "${key}"`);
    }
  }

  return {
    ...(input.input === undefined ? {} : { input: stringValue(input.input, "input", sourcePath) }),
    ...(input.output === undefined ? {} : { output: stringValue(input.output, "output", sourcePath) }),
    ...(input.paths === undefined ? {} : { paths: stringArray(input.paths, "paths", sourcePath) }),
    ...(input.ignoreHeaders === undefined
      ? {}
      : { ignoreHeaders: stringArray(input.ignoreHeaders, "ignoreHeaders", sourcePath) }),
    ...(input.strict === undefined ? {} : { strict: booleanValue(input.strict, "strict", sourcePath) }),
    ...(input.har === undefined ? {} : { har: validateHar(input.har, sourcePath) }),
  };
};

export const findConfigFile = (startDirectory: string): string | undefined => {
  let directory = resolve(startDirectory);

  while (true) {
    const candidate = join(directory, CONFIG_FILE_NAME);
    if (existsSync(candidate)) {
      if (!statSync(candidate).isFile()) {
        throw new ConfigurationError(`${candidate}: configuration path is not a file`);
      }
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
};

export const loadConfig = async (options: { cwd: string; explicitPath?: string }): Promise<LoadedConfig> => {
  const explicitPath = options.explicitPath ? resolve(options.cwd, options.explicitPath) : undefined;
  const configPath = explicitPath ?? findConfigFile(options.cwd);

  if (!configPath) {
    return { config: {} };
  }
  if (!existsSync(configPath)) {
    throw new ConfigurationError(`${configPath}: configuration file does not exist`);
  }
  if (!statSync(configPath).isFile()) {
    throw new ConfigurationError(`${configPath}: configuration path is not a file`);
  }

  try {
    const jiti = createJiti(pathToFileURL(configPath).href, { moduleCache: false });
    const module = await jiti.import<unknown>(configPath);
    if (
      (typeof module !== "object" && typeof module !== "function") ||
      module === null ||
      !Object.prototype.hasOwnProperty.call(module, "default")
    ) {
      throw new ConfigurationError(`${configPath}: configuration file must have a default export`);
    }
    return {
      config: validateConfig((module as { default: unknown }).default, configPath),
      path: configPath,
    };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`${configPath}: could not load configuration: ${message}`, { cause: error });
  }
};

export const resolveConfig = async (options: {
  cwd?: string;
  overrides?: CliConfigOverrides;
}): Promise<ResolvedConfig> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const overrides = options.overrides ?? {};
  const loaded = await loadConfig({ cwd, explicitPath: overrides.config });
  const configDirectory = loaded.path ? dirname(loaded.path) : cwd;
  const resolveInput = (base: string, value: string): string => (/^https?:\/\//i.test(value) ? value : resolve(base, value));
  const configInput = loaded.config.input ? resolveInput(configDirectory, loaded.config.input) : undefined;
  const configOutput = loaded.config.output ? resolve(configDirectory, loaded.config.output) : undefined;
  const input = overrides.input ? resolveInput(cwd, overrides.input) : configInput;

  if (!input) {
    throw new ConfigurationError(
      `No API document was provided. Pass a path to the generate command or set "input" in the config file.`,
    );
  }

  return {
    input,
    output: overrides.output ? resolve(cwd, overrides.output) : (configOutput ?? resolve(cwd, "generated-api")),
    paths: overrides.paths ?? loaded.config.paths,
    ignoreHeaders: overrides.ignoreHeaders ?? loaded.config.ignoreHeaders ?? [],
    strict: overrides.strict ?? loaded.config.strict,
    har: loaded.config.har,
  };
};
