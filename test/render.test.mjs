import assert from "node:assert/strict";
import { it } from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeOpenApiDocument } = await jiti.import("../src/openapi/index.ts");
const { renderClientFiles, renderIndexFile, renderSchemaFiles } = await jiti.import("../src/generator/index.ts");

const doc = {
  openapi: "3.0.3",
  info: { title: "T", version: "1" },
  paths: {
    "/things": {
      post: {
        tags: ["things"],
        operationId: "createThing",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } },
        },
        responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/login": {
      post: {
        tags: ["things"],
        operationId: "login",
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              schema: { type: "object", properties: { user: { type: "string" } } },
            },
          },
        },
        responses: { 204: { description: "ok" } },
      },
    },
    "/upload": {
      post: {
        tags: ["things"],
        operationId: "uploadThing",
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
            },
          },
        },
        responses: { 204: { description: "ok" } },
      },
    },
  },
};

it("renders body keys, UploadFile and a target-agnostic index", () => {
  const api = normalizeOpenApiDocument(doc);
  const clients = renderClientFiles(api).map((file) => file.content).join("\n");
  const schemas = renderSchemaFiles(api).map((file) => file.content).join("\n");
  const index = renderIndexFile(api).content;

  assert.match(clients, /data: request\?\.body/);
  assert.match(clients, /form: request\?\.body/);
  assert.match(clients, /multipart: request\?\.body === undefined \? undefined : toMultipartForm\(request\.body\)/);
  assert.doesNotMatch(clients, /Multipart\(/);
  assert.doesNotMatch(clients, /MultipartPayload/);
  assert.match(schemas, /z\.custom<UploadFile>\(\)/);
  assert.match(schemas, /import type \{ UploadFile \} from "zod-api-client\/runtime";/);
  assert.match(schemas, /body: /);
  assert.doesNotMatch(index, /@playwright\/test/);
  assert.match(index, /ClientOptions, ClientTarget/);
  assert.match(index, /createApiClient = \(target\?: ClientTarget \| ClientOptions, options\?: ClientOptions\)/);
});
