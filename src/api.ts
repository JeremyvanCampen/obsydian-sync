/**
 * Typed client for the sync server. See ../../protocol/PROTOCOL.md §4.
 *
 * Transport is injected so the whole client is testable without a network and
 * without Obsidian. Production passes the transport from
 * `obsidian-transport.ts`, which wraps `requestUrl`; this module deliberately
 * imports nothing from `obsidian`, so the tests can exercise it directly.
 */

import type {
  JournalAppendResponse,
  JournalEntry,
  JournalPage,
  VaultMeta,
} from "./types.ts";
import type { Bytes } from "./crypto.ts";

export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "HEAD";
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  // Written out rather than using constructor parameter properties: Node's
  // type-stripping does not support those, and the sources are run directly by
  // node (scripts/gen-vectors.ts) as well as bundled.
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** 4xx means the request itself is wrong; retrying it unchanged cannot help. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export interface ApiOptions {
  baseUrl: string;
  token: string;
  transport: Transport;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  /** Injected for tests; production uses a real delay. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Entries per journal request. Exposed so a test can force `journalAll` to
   * page without writing hundreds of entries — otherwise the paging path is
   * unreachable in practice and quietly untested.
   */
  pageLimit?: number;
}

const DEFAULT_ATTEMPTS = 3;

interface RequestOpts {
  method: HttpRequest["method"];
  path: string;
  body?: string | ArrayBuffer;
  contentType?: string;
  /** Non-2xx statuses that are a normal answer rather than a failure. */
  allowStatuses?: number[];
}

export class SyncApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly transport: Transport;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pageLimit: number;

  constructor(opts: ApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.transport = opts.transport;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_ATTEMPTS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pageLimit = opts.pageLimit ?? 500;
  }

  // --- meta ---------------------------------------------------------------

  async meta(): Promise<VaultMeta> {
    return this.json<VaultMeta>({ method: "GET", path: "/v1/meta" });
  }

  /** Permitted once per vault; a second call is answered with 409. */
  async initMeta(kdfCheck: string): Promise<void> {
    await this.request({
      method: "POST",
      path: "/v1/meta/init",
      body: JSON.stringify({ kdfCheck }),
      contentType: "application/json",
    });
  }

  // --- journal ------------------------------------------------------------

  async journalSince(since: number, limit = this.pageLimit): Promise<JournalPage> {
    return this.json<JournalPage>({
      method: "GET",
      path: `/v1/journal?since=${since}&limit=${limit}`,
    });
  }

  /** Pages until the server reports no more, so callers see one flat list. */
  async journalAll(since: number): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    let cursor = since;
    for (;;) {
      const page = await this.journalSince(cursor);
      out.push(...page.entries);
      if (!page.more || page.entries.length === 0) return out;
      const last = page.entries[page.entries.length - 1];
      if (!last || last.seq <= cursor) {
        // The server promised more but did not advance; stop rather than loop.
        return out;
      }
      cursor = last.seq;
    }
  }

  /**
   * Retry-safe: `entryId` is the idempotency key, so a resubmitted batch
   * returns the original sequence numbers instead of appending duplicates.
   */
  async appendJournal(
    entries: Array<{ entryId: string; payload: string }>,
  ): Promise<JournalAppendResponse> {
    return this.json<JournalAppendResponse>({
      method: "POST",
      path: "/v1/journal",
      body: JSON.stringify({ entries }),
      contentType: "application/json",
    });
  }

  // --- blobs --------------------------------------------------------------

  async hasBlob(blobId: string): Promise<boolean> {
    // Goes through `request` like everything else: this runs before every
    // upload, so a single dropped connection here would abort a whole sync —
    // exactly the condition the retry logic exists for.
    const res = await this.request({
      method: "HEAD",
      path: `/v1/blob/${blobId}`,
      allowStatuses: [404],
    });
    return res.status !== 404;
  }

  async getBlob(blobId: string): Promise<Bytes> {
    const res = await this.request({ method: "GET", path: `/v1/blob/${blobId}` });
    return new Uint8Array(res.arrayBuffer) as Bytes;
  }

  /** Idempotent by content address, so retrying an upload is always safe. */
  async putBlob(blobId: string, sealed: Bytes): Promise<void> {
    await this.request({
      method: "PUT",
      path: `/v1/blob/${blobId}`,
      // Copy into a standalone buffer: a subarray view would send the whole
      // backing store.
      body: sealed.slice().buffer,
      contentType: "application/octet-stream",
    });
  }

  async gc(live: string[], expectedHead: number, force = false): Promise<unknown> {
    return this.json({
      method: "POST",
      path: `/v1/gc${force ? "?force=true" : ""}`,
      body: JSON.stringify({ live, expectedHead }),
      contentType: "application/json",
    });
  }

  // --- plumbing -----------------------------------------------------------

  private build(opts: RequestOpts): HttpRequest {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    return {
      url: `${this.baseUrl}${opts.path}`,
      method: opts.method,
      headers,
      body: opts.body,
      contentType: opts.contentType,
    };
  }

  private async request(opts: RequestOpts): Promise<HttpResponse> {
    const req = this.build(opts);
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: HttpResponse;
      try {
        res = await this.transport(req);
      } catch (e) {
        // A transport-level failure is the phone losing its connection
        // mid-request. Worth retrying; every route here is idempotent.
        lastError = e;
        if (attempt === this.maxAttempts) break;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (res.status >= 200 && res.status < 300) return res;
      if (opts.allowStatuses?.includes(res.status)) return res;

      const err = this.toError(res);
      // A 4xx will fail identically however many times it is sent.
      if (err.isClientError) throw err;
      lastError = err;
      if (attempt === this.maxAttempts) break;
      await this.sleep(backoffMs(attempt));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`request failed: ${String(lastError)}`);
  }

  private async json<T>(opts: RequestOpts): Promise<T> {
    const res = await this.request(opts);
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new ApiError(res.status, "bad_response", "server returned a non-JSON body");
    }
  }

  private toError(res: HttpResponse): ApiError {
    try {
      const body = JSON.parse(res.text) as { error?: { code?: string; message?: string } };
      if (body.error?.code) {
        return new ApiError(res.status, body.error.code, body.error.message ?? body.error.code);
      }
    } catch {
      // Not our JSON error shape — fall through to a generic message. This is
      // what a proxy's own error page looks like.
    }
    return new ApiError(res.status, "http_error", `HTTP ${res.status}`);
  }
}

/** 250ms, 500ms, 1s, ... capped. Jitter avoids devices retrying in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(250 * 2 ** (attempt - 1), 4000);
  return base + Math.floor(Math.random() * 100);
}
