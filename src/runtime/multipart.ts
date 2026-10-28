import type { MultipartPayload, UploadFile } from "./types.js";

export function toMultipartForm(form: Record<string, unknown>): MultipartPayload {
  return Object.fromEntries(
    Object.entries(form)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, isUploadFile(value) ? value : serializeValue(value)]),
  );
}

function isUploadFile(value: unknown): value is UploadFile {
  return (
    value instanceof Blob ||
    value instanceof Uint8Array ||
    (typeof value === "object" && value !== null && "buffer" in value && "mimeType" in value)
  );
}

export function serializeFormValues(form: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(form)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, serializeValue(value)]),
  );
}

function serializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    const containsObjects = value.some((item) => item !== null && typeof item === "object");
    return containsObjects ? stringify(value) : String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    return stringify(value);
  }

  return String(value);
}

function stringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Form values must be JSON-serializable");
  }
  return serialized;
}
