import type { FormPayload, MultipartPayload } from "./types.js";

export function toFormData(multipart: MultipartPayload): FormData {
  if (multipart instanceof FormData) {
    return multipart;
  }

  const form = new FormData();
  for (const [name, value] of Object.entries(multipart)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      form.append(name, String(value));
    } else if (value instanceof Blob) {
      form.append(name, value, "name" in value && typeof value.name === "string" ? value.name : name);
    } else if (value instanceof Uint8Array) {
      form.append(name, new Blob([value as BlobPart]), name);
    } else {
      form.append(name, new Blob([value.buffer as BlobPart], { type: value.mimeType }), value.name);
    }
  }
  return form;
}

export function withoutContentType(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"));
}

export function toFormBody(form: FormPayload): FormData | URLSearchParams {
  return form instanceof FormData
    ? form
    : new URLSearchParams(Object.entries(form).map(([name, value]) => [name, String(value)]));
}
