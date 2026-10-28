# Using `zod-api-client`

## 1. Install

```bash
npm install --save-dev zod-api-client zod@^4.4.3
```

Add `@playwright/test` too if you'll call the API from Playwright tests.

## 2. Configure generation

Add `zod-api-client.config.ts`:

```ts
import { defineConfig } from "zod-api-client";

export default defineConfig({
  input: "./openapi.yaml", // or Swagger 2.0, OpenAPI 3.1, a Postman export, a .har file, or a URL
  output: "./src/generated-api",
});
```

Add a script to `package.json`:

```json
{
  "scripts": {
    "generate:api": "zod-api-client generate"
  }
}
```

Generate the client:

```bash
npm run generate:api
```

Run it again whenever the API document changes. Don't edit files in the output folder by hand.

## 3. Use the generated client

```ts
import { test } from "@playwright/test";
import { createApiClient } from "./src/generated-api";

test("creates a pet", async ({ request }) => {
  const api = createApiClient(request);
  const pet = await api.pets.registerPet({ body: { name: "Rex" } });
});
```

Outside Playwright, pass a base URL (uses the built-in `fetch`) or an existing axios instance:

```ts
const api = createApiClient({ baseURL: "https://api.example.com" });
const api = createApiClient(myAxios);
```

Successful responses are validated against their generated Zod schemas. Non-2xx responses throw `ApiHttpError`; invalid successful responses throw `ResponseValidationError`.

See [README.md](./README.md) for the full reference.
