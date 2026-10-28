import type { NormalizedApi } from "../openapi/index.js";
import type { RenderedFile } from "./render-schemas.js";

export const renderIndexFile = (api: NormalizedApi): RenderedFile => {
  const imports = api.groups.map((group) => `import { ${group.clientName} } from "./clients/${group.fileName}.js";`);
  const exports = api.groups.flatMap((group) => [
    `export * from "./clients/${group.fileName}.js";`,
    `export * from "./schemas/${group.fileName}.js";`,
  ]);
  const clients = api.groups.map(
    (group) => `${JSON.stringify(group.fileName)}: new ${group.clientName}(target, options)`,
  );

  return {
    path: "index.ts",
    content: `import type { ClientOptions, ClientTarget } from "zod-api-client/runtime";
${imports.join("\n")}

${exports.join("\n")}

export const createApiClient = (target?: ClientTarget | ClientOptions, options?: ClientOptions) => ({
  ${clients.join(",\n")}
});

export type ApiClient = ReturnType<typeof createApiClient>;
`,
  };
};
