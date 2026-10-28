import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { generate } = await jiti.import("../src/generator/index.ts");

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const generateFrom = async (input, options = {}) => {
  const output = await mkdtemp(path.join(tmpdir(), "zod-api-client-"));
  const result = await generate({ input, output, ...options });
  const contents = await Promise.all(
    (await readdir(output, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => readFile(path.join(entry.parentPath ?? entry.path, entry.name), "utf8")),
  );
  return { result, code: contents.join("\n") };
};

test("Swagger 2.0 input", async () => {
  const { code } = await generateFrom(fixture("swagger2.json"));
  assert.match(code, /getPet/);
  assert.match(code, /createPet/);
  assert.match(code, /\/pets\/\$\{/);
});

test("OpenAPI 3.1 input", async () => {
  const { code } = await generateFrom(fixture("openapi31.json"));
  assert.match(code, /getItem/);
  assert.match(code, /nullable/);
  assert.match(code, /literal\("item"\)/);
  assert.match(code, /\.gt\(0\)/);
});

test("OpenAPI 3.0 YAML input", async () => {
  const { code } = await generateFrom(fixture("openapi30.yaml"));
  assert.match(code, /listBooks/);
  assert.match(code, /limit/);
});

test("Postman collection input", async () => {
  const { code } = await generateFrom(fixture("postman.json"));
  assert.match(code, /class Admin\b/);
  assert.match(code, /updateUser/);
  assert.match(code, /\/users\/\$\{/);
});

test("HAR input filters by host", async () => {
  const { code } = await generateFrom(fixture("capture.har"), { har: { hosts: ["api.example.com"] } });
  assert.match(code, /\/users\/\$\{/);
  assert.doesNotMatch(code, /widgets/);
  assert.doesNotMatch(code, /\/index/);
});

test("lenient mode skips unsupported operations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zod-api-client-in-"));
  const input = path.join(dir, "api.json");
  const response = { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } } };
  await writeFile(
    input,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Mixed", version: "1.0.0" },
      paths: {
        "/good": { get: { operationId: "goodOp", tags: ["good"], responses: response } },
        "/bad": {
          get: {
            operationId: "badOp",
            tags: ["bad"],
            parameters: [{ name: "filter", in: "query", style: "deepObject", schema: { type: "string" } }],
            responses: response,
          },
        },
      },
    }),
  );
  await assert.rejects(() => generateFrom(input), /deepObject/);
  const { result, code } = await generateFrom(input, { strict: false });
  assert.match(code, /goodOp/);
  assert.doesNotMatch(code, /badOp/);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].operation, "GET /bad");
  assert.match(result.skipped[0].reason, /deepObject/);
  const filtered = await generateFrom(input, { strict: false, paths: ["/good"] });
  assert.deepEqual(filtered.result.skipped, []);
});

test("URL input", async () => {
  const body = await readFile(fixture("swagger2.json"), "utf8");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { code } = await generateFrom(`http://127.0.0.1:${server.address().port}/openapi.json`);
    assert.match(code, /getPet/);
  } finally {
    server.close();
  }
});

test("Postman: templated bodies, duplicate names, string-URL query, no examples", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zod-api-client-"));
  const input = path.join(dir, "collection.json");
  const request = (name, method, url, body) => ({ name, request: { method, url, ...(body ? { body } : {}) } });
  await writeFile(
    input,
    JSON.stringify({
      info: { name: "Edge", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        request("Create user", "POST", "{{baseUrl}}/users", { mode: "raw", raw: '{"name": "{{userName}}", "age": {{age}}}' }),
        request("Get user", "GET", "{{baseUrl}}/users/:userId?verbose=true"),
        request("Dup", "GET", "{{baseUrl}}/dup/a"),
        request("Dup", "GET", "{{baseUrl}}/dup/b"),
      ],
    }),
  );
  const { code } = await generateFrom(input);
  assert.match(code, /createUserRequestSchema = z\.object\(\{ body:/);
  assert.match(code, /verbose/);
  assert.match(code, /dup2\(/);
  assert.match(code, /getUserSchema = z\.unknown\(\)/);
});

test("HAR: hosts match with or without a port", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zod-api-client-"));
  const input = path.join(dir, "capture.har");
  const entry = {
    request: { method: "GET", url: "http://localhost:3000/items/1", queryString: [] },
    response: { status: 200, content: { mimeType: "application/json", text: '{"id":1}' } },
  };
  await writeFile(input, JSON.stringify({ log: { entries: [entry] } }));
  const { code } = await generateFrom(input, { har: { hosts: ["localhost"] } });
  assert.match(code, /class Items/);
});

test("HAR: multipart uploads keep file fields, from params or raw text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zod-api-client-"));
  const input = path.join(dir, "capture.har");
  const response = { status: 200, content: { mimeType: "application/json", text: '{"ok":true}' } };
  const boundary = "----b";
  const raw = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="caption"',
    "",
    "Rex",
    `--${boundary}`,
    'Content-Disposition: form-data; name="photo"; filename="rex.png"',
    "Content-Type: image/png",
    "",
    "PNG",
    `--${boundary}--`,
  ].join("\r\n");
  const entries = [
    {
      request: {
        method: "POST",
        url: "http://api.test/pets/1/photo",
        postData: {
          mimeType: "multipart/form-data; boundary=x",
          params: [{ name: "caption", value: "Rex" }, { name: "photo", fileName: "rex.png", contentType: "image/png" }],
        },
      },
      response,
    },
    {
      request: { method: "POST", url: "http://api.test/docs", postData: { mimeType: `multipart/form-data; boundary=${boundary}`, text: raw } },
      response,
    },
  ];
  await writeFile(input, JSON.stringify({ log: { entries } }));
  const { code } = await generateFrom(input);
  assert.equal(code.match(/photo: z\.custom<UploadFile>\(\)/g)?.length, 2);
  assert.match(code, /caption: z\.string\(\)/);
  assert.match(code, /toMultipartForm\(request\.body\)/);
  assert.match(code, /pathSegment\(id\)/);
});
