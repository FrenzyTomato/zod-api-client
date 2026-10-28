import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import axios from "axios";
import { createJiti } from "jiti";
import { z } from "zod";

const jiti = createJiti(import.meta.url);
const { ActionBase, ApiHttpError, ResponseValidationError } = await jiti.import("../src/runtime/index.ts");

class TestClient extends ActionBase {
  json(body, query) {
    return this.post("/json", { data: body, params: query });
  }
  form(form) {
    return this.post("/form", { form });
  }
  upload(multipart) {
    return this.post("/upload", { multipart });
  }
  missing() {
    return this.get("/missing");
  }
  invalid() {
    return this.get("/json", { responseSchema: z.object({ method: z.number() }) });
  }
}

let server;
let baseURL;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/missing") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "nope" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        contentType: req.headers["content-type"],
        xTest: req.headers["x-test"],
        body: Buffer.concat(chunks).toString("latin1"),
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const targets = {
  fetch: async () => ({ make: () => new TestClient({ baseURL }), headers: {} }),
  playwright: async () => {
    const { request } = await import("@playwright/test");
    const ctx = await request.newContext({ baseURL });
    return { make: () => new TestClient(ctx), dispose: () => ctx.dispose(), headers: {} };
  },
  axios: async () => {
    const instance = axios.create({ baseURL });
    instance.interceptors.request.use((config) => {
      config.headers.set("x-test", "interceptor");
      return config;
    });
    return { make: () => new TestClient(instance), headers: { xTest: "interceptor" } };
  },
};

for (const [name, setup] of Object.entries(targets)) {
  describe(name, () => {
    let t;
    before(async () => {
      t = await setup();
    });
    after(() => t.dispose?.());

    it("sends JSON with a query param", async () => {
      const res = await t.make().json({ a: 1 }, { q: "x y" });
      assert.equal(res.method, "POST");
      assert.equal(res.path, "/json");
      assert.deepEqual(res.query, { q: "x y" });
      assert.match(res.contentType, /^application\/json/);
      assert.deepEqual(JSON.parse(res.body), { a: 1 });
      assert.equal(res.xTest, t.headers.xTest);
    });

    it("sends urlencoded forms", async () => {
      const res = await t.make().form({ a: "1", b: true });
      assert.match(res.contentType, /^application\/x-www-form-urlencoded/);
      assert.equal(res.body, "a=1&b=true");
    });

    for (const [label, file] of [
      ["Buffer", Buffer.from("hello-bytes")],
      ["{ name, mimeType, buffer }", { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello-bytes") }],
    ]) {
      it(`sends multipart with ${label}`, async () => {
        const res = await t.make().upload({ title: "T", file });
        assert.match(res.contentType, /^multipart\/form-data; boundary=/);
        assert.match(res.body, /name="title"/);
        assert.match(res.body, /name="file"; filename="(file|a\.txt)"/);
        assert.match(res.body, /hello-bytes/);
        assert.equal(res.xTest, t.headers.xTest);
      });
    }

    it("throws ApiHttpError on 404", async () => {
      await assert.rejects(t.make().missing(), (error) => {
        assert.ok(error instanceof ApiHttpError);
        assert.equal(error.status, 404);
        return true;
      });
    });

    it("throws ResponseValidationError on schema mismatch", async () => {
      await assert.rejects(t.make().invalid(), ResponseValidationError);
    });
  });
}

it("keeps a baseURL path prefix", async () => {
  const res = await new TestClient({ baseURL: `${baseURL}/v1` }).json({ a: 1 }, {});
  assert.equal(res.path, "/v1/json");
});

describe("pathSegment", () => {
  it("encodes values and rejects dot segments", async () => {
    const { pathSegment } = await jiti.import("../src/runtime/index.ts");
    assert.equal(pathSegment("a/b c"), "a%2Fb%20c");
    assert.equal(pathSegment(42), "42");
    assert.throws(() => pathSegment(".."), /cannot be sent/);
    assert.throws(() => pathSegment("."), /cannot be sent/);
  });
});
