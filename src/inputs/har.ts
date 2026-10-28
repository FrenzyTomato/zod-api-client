import type { OpenAPIV3 } from "openapi-types";
import { inferSchema } from "./infer-schema.js";

type Json = Record<string, any>;

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const STRING_SCHEMA: OpenAPIV3.SchemaObject = { type: "string" };

const mimeOf = (mimeType: unknown): string => String(mimeType ?? "").toLowerCase().split(";", 1)[0].trim();
const isJson = (mime: string): boolean => mime === "application/json" || mime.endsWith("+json");
const isText = (mime: string): boolean =>
  mime.startsWith("text/") && !["text/html", "text/css", "text/javascript"].includes(mime);

const templatePath = (pathname: string): { path: string; segments: string[] } => {
  const counts = new Map<string, number>();
  const segments = pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      if (!/^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(segment)) return segment;
      const count = (counts.get("id") ?? 0) + 1;
      counts.set("id", count);
      return count === 1 ? "{id}" : `{id${count}}`;
    });
  return { path: `/${segments.join("/")}`, segments };
};

const parseBody = (content: Json): unknown => {
  if (typeof content.text !== "string" || content.text === "") return undefined;
  const text = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Some exporters record only the raw multipart text, so read field names from its part headers.
const multipartParams = (text: unknown): Json[] =>
  typeof text === "string"
    ? [...text.matchAll(/content-disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/gi)].map(
        ([, name, fileName]) => ({ name, fileName }),
      )
    : [];

interface Group {
  method: string;
  path: string;
  tag?: string;
  entries: Json[];
}

export const convertHar = (har: Json, options: { hosts?: string[] } = {}): OpenAPIV3.Document => {
  const groups = new Map<string, Group>();
  for (const entry of har.log.entries as Json[]) {
    const method = String(entry.request?.method ?? "").toLowerCase();
    const mime = mimeOf(entry.response?.content?.mimeType);
    if (!METHODS.has(method) || !(isJson(mime) || isText(mime))) continue;
    let url: URL;
    try {
      url = new URL(entry.request.url);
    } catch {
      continue;
    }
    if (options.hosts && !options.hosts.includes(url.host) && !options.hosts.includes(url.hostname)) continue;
    const { path, segments } = templatePath(url.pathname);
    const key = `${method} ${path}`;
    const group = groups.get(key) ?? {
      method,
      path,
      tag: segments.find((segment) => !segment.startsWith("{")),
      entries: [],
    };
    group.entries.push(entry);
    groups.set(key, group);
  }

  const paths: OpenAPIV3.PathsObject = {};
  for (const group of groups.values()) {
    const names = [...group.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const queryNames = [
      ...new Set(group.entries.flatMap((entry) => (entry.request.queryString ?? []).map((query: Json) => query.name))),
    ] as string[];
    const parameters: OpenAPIV3.ParameterObject[] = [
      ...names.map((name): OpenAPIV3.ParameterObject => ({ name, in: "path", required: true, schema: STRING_SCHEMA })),
      ...queryNames.map(
        (name): OpenAPIV3.ParameterObject => ({
          name,
          in: "query",
          required: group.entries.every((entry) =>
            (entry.request.queryString ?? []).some((query: Json) => query.name === name),
          ),
          schema: STRING_SCHEMA,
        }),
      ),
    ];

    let requestBody: OpenAPIV3.RequestBodyObject | undefined;
    const posted = group.entries.filter((entry) => entry.request.postData);
    const postMime = mimeOf(posted[0]?.request.postData.mimeType);
    if (isJson(postMime)) {
      const samples = posted.flatMap((entry) => {
        try {
          return [JSON.parse(entry.request.postData.text)];
        } catch {
          return [];
        }
      });
      if (samples.length > 0) requestBody = { content: { "application/json": { schema: inferSchema(samples) } } };
    } else if (postMime === "application/x-www-form-urlencoded" || postMime === "multipart/form-data") {
      const params: Json[] = posted.flatMap((entry) => entry.request.postData.params ?? multipartParams(entry.request.postData.text));
      const properties = Object.fromEntries(
        params.map((param): [string, OpenAPIV3.SchemaObject] => [
          param.name,
          params.some((other) => other.name === param.name && other.fileName !== undefined)
            ? { type: "string", format: "binary" }
            : STRING_SCHEMA,
        ]),
      );
      requestBody = { content: { [postMime]: { schema: { type: "object", properties } } } };
    }

    const responses: OpenAPIV3.ResponsesObject = {};
    const byStatus = new Map<string, Json[]>();
    for (const entry of group.entries) {
      const status = String(entry.response.status);
      byStatus.set(status, [...(byStatus.get(status) ?? []), entry.response]);
    }
    for (const [status, list] of byStatus) {
      const description = list[0].statusText || status;
      const contents = list.filter((response) => response.content?.text);
      const mime = mimeOf(contents[0]?.content.mimeType);
      if (contents.length === 0) {
        responses[status] = { description };
      } else if (isJson(mime)) {
        const samples = contents.map((response) => parseBody(response.content)).filter((sample) => sample !== undefined);
        responses[status] = {
          description,
          content: { [mime]: { schema: samples.length > 0 ? inferSchema(samples) : STRING_SCHEMA } },
        };
      } else {
        responses[status] = { description, content: { "text/plain": { schema: STRING_SCHEMA } } };
      }
    }

    const pathItem = (paths[group.path] ??= {}) as Record<string, OpenAPIV3.OperationObject>;
    pathItem[group.method] = {
      ...(group.tag ? { tags: [group.tag] } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
    };
  }

  return { openapi: "3.0.3", info: { title: "HAR capture", version: "1.0.0" }, paths };
};
