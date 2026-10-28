declare module "swagger2openapi" {
  export const convertObj: (
    document: object,
    options: { patch?: boolean; warnOnly?: boolean },
  ) => Promise<{ openapi: object }>;
}
