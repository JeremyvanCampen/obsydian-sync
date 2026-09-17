/**
 * The one place that talks to Obsidian's HTTP client.
 *
 * `requestUrl` rather than `fetch`: it has no CORS restrictions and behaves
 * identically on desktop and mobile, where a plugin has no origin to speak of.
 * Keeping it isolated is what lets `api.ts` — and everything above it — be
 * tested without a running Obsidian.
 */

import { requestUrl } from "obsidian";
import type { Transport } from "./api.ts";

export function obsidianTransport(): Transport {
  return async (req) => {
    const res = await requestUrl({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      contentType: req.contentType,
      // Handle status codes ourselves: a 404 from HEAD /blob is a normal
      // answer, not an exception.
      throw: false,
    });
    return { status: res.status, text: res.text, arrayBuffer: res.arrayBuffer };
  };
}
