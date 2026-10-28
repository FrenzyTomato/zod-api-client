export interface ZodClientGeneratorConfig {
  input?: string;
  output?: string;
  paths?: string[];
  ignoreHeaders?: string[];
  strict?: boolean;
  har?: { hosts?: string[] };
}

export interface ResolvedConfig {
  input: string;
  output: string;
  paths?: string[];
  ignoreHeaders: string[];
  strict?: boolean;
  har?: { hosts?: string[] };
}

export interface CliConfigOverrides {
  input?: string;
  output?: string;
  paths?: string[];
  ignoreHeaders?: string[];
  strict?: boolean;
  config?: string;
}

export const defineConfig = (config: ZodClientGeneratorConfig): ZodClientGeneratorConfig => config;
