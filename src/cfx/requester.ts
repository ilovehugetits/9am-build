import type { APIRequestContext, APIResponse } from "playwright";
import type { Requester, HttpResponse, MultipartField } from "./api.js";

function wrap(res: APIResponse): HttpResponse {
  return {
    status: res.status(),
    ok: res.ok(),
    json: () => res.json(),
    text: () => res.text(),
  };
}

export function playwrightRequester(ctx: APIRequestContext): Requester {
  return {
    async get(url) {
      return wrap(await ctx.get(url));
    },
    async postJson(url, body) {
      return wrap(await ctx.post(url, { data: body as any }));
    },
    async postMultipart(url, fields) {
      const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {};
      for (const f of fields) {
        multipart[f.name] =
          typeof f.value === "string"
            ? f.value
            : { name: f.value.fileName, mimeType: f.value.mimeType, buffer: f.value.buffer };
      }
      return wrap(await ctx.post(url, { multipart }));
    },
    async del(url) {
      return wrap(await ctx.delete(url));
    },
  };
}
