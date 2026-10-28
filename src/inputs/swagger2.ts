import { convertObj } from "swagger2openapi";
import type { OpenAPIV3 } from "openapi-types";

export const convertSwagger2 = async (raw: object): Promise<OpenAPIV3.Document> => {
  const { openapi } = await convertObj(raw, { patch: true, warnOnly: true });
  return openapi as OpenAPIV3.Document;
};
