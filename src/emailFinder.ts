// REST client for the email finder endpoints in the backend spec:
// POST /api/v1/email_finder
// POST /api/v1/email_finder/bulk/upload
// POST /api/v1/email_finder/bulk/:id/start
// GET  /api/v1/email_finder/bulk/:id
// GET  /api/v1/batches/:id/finder_rows
// DELETE /api/v1/batches/:id

const DEFAULT_BASE_URL = "https://api.truelist.io";
const REQUEST_TIMEOUT_MS = 60_000;
const FINDER_ROWS_PAGE_LIMIT = 100;

export const FIND_CREDIT_PRICE = 25;
export const BULK_FIND_MAX_ROWS = 10_000;
export const BULK_RESULTS_DEFAULT_LIMIT = 25;
export const BULK_RESULTS_MAX_LIMIT = FINDER_ROWS_PAGE_LIMIT;

export const FIND_STATUSES = [
  "not_processed",
  "skipped",
  "searching",
  "verified",
  "no_match",
  "no_confident_match",
  "no_mx",
  "invalid_input",
  "error",
] as const;

export type FindStatus = (typeof FIND_STATUSES)[number];

export const BULK_COLUMN_MAP = {
  first_name: 0,
  last_name: 1,
  domain: 2,
  email: 3,
} as const;

const BULK_CSV_HEADERS = ["First Name", "Last Name", "Domain", "Email"];

export type JsonObject = Record<string, unknown>;

export class FinderApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    const detail = message.trim();
    const text = detail.startsWith(`${code}:`) ? detail : `${code}: ${detail}`;
    super(text);
    this.name = "FinderApiError";
    this.code = code;
    this.status = status;
  }
}

export type FinderRowInput = {
  first_name: string;
  last_name: string;
  domain: string;
  email?: string;
};

export type BulkFindResultPage = {
  id: string;
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  counts: Record<string, number>;
  rows: JsonObject[];
};

type FetchLike = typeof fetch;

type RequestOptions = {
  json?: unknown;
  body?: string;
  contentType?: string;
  query?: Record<string, string | number | undefined>;
};

export type EmailFinderClientOptions = {
  baseUrl?: string;
  fetch?: FetchLike;
};

export class EmailFinderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(apiKey: string, options: EmailFinderClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async findEmail(input: {
    first_name: string;
    last_name: string;
    domain: string;
  }): Promise<JsonObject> {
    return this.request("POST", "/api/v1/email_finder", { json: input });
  }

  async startBulkFind(input: {
    rows: FinderRowInput[];
    credit_cap: number;
    name?: string;
  }): Promise<JsonObject> {
    const filename = listFilename(input.name);
    const upload = csvUpload(rowsToCsv(input.rows), filename);
    const uploaded = await this.request("POST", "/api/v1/email_finder/bulk/upload", {
      body: upload.body,
      contentType: upload.contentType,
    });
    const listId = readString(uploaded, "id");
    if (!listId) {
      throw new Error("Truelist did not return a list id for the bulk find upload.");
    }

    try {
      const started = await this.request(
        "POST",
        `/api/v1/email_finder/bulk/${encodeURIComponent(listId)}/start`,
        {
          json: {
            map: BULK_COLUMN_MAP,
            credit_cap: input.credit_cap,
          },
        },
      );
      return {
        id: readString(started, "id") ?? listId,
        name: readString(uploaded, "name") ?? filename,
        run: started.run ?? null,
      };
    } catch (error) {
      await this.deleteList(listId);
      throw error;
    }
  }

  async getBulkFind(listId: string): Promise<JsonObject> {
    return this.request(
      "GET",
      `/api/v1/email_finder/bulk/${encodeURIComponent(listId)}`,
    );
  }

  async listBulkFindResults(input: {
    list_id: string;
    find_status?: FindStatus;
    limit: number;
    offset: number;
  }): Promise<BulkFindResultPage> {
    const collected: JsonObject[] = [];
    let skipped = 0;
    let after: number | undefined;
    let counts: Record<string, number> = {};
    let exhausted = false;

    const pull = async (pageLimit: number): Promise<JsonObject[]> => {
      const page = await this.request(
        "GET",
        `/api/v1/batches/${encodeURIComponent(input.list_id)}/finder_rows`,
        {
          query: {
            limit: pageLimit,
            after,
            find_status: input.find_status,
          },
        },
      );
      const rows = Array.isArray(page.rows) ? page.rows.filter(isJsonObject) : [];
      counts = readCounts(page.counts);
      const nextAfter = page.next_after;
      if (typeof nextAfter === "number") {
        after = nextAfter;
      } else {
        exhausted = true;
      }
      if (rows.length < pageLimit) {
        exhausted = true;
      }
      return rows;
    };

    while (skipped < input.offset && !exhausted) {
      const need = Math.min(FINDER_ROWS_PAGE_LIMIT, input.offset - skipped);
      const rows = await pull(need);
      skipped += rows.length;
      if (rows.length === 0) {
        exhausted = true;
      }
    }

    while (collected.length < input.limit && !exhausted) {
      const need = Math.min(
        FINDER_ROWS_PAGE_LIMIT,
        input.limit - collected.length,
      );
      const rows = await pull(need);
      collected.push(...rows.slice(0, input.limit - collected.length));
      if (rows.length === 0) {
        exhausted = true;
      }
    }

    const total = totalCount(counts, input.find_status);
    const nextOffset = input.offset + input.limit;
    const hasMore = nextOffset < total;
    return {
      id: input.list_id,
      total_count: total,
      limit: input.limit,
      offset: input.offset,
      has_more: hasMore,
      next_offset: hasMore ? nextOffset : null,
      counts,
      rows: collected,
    };
  }

  private async deleteList(listId: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/api/v1/batches/${encodeURIComponent(listId)}`,
      );
    } catch {
      // The start error is the one the caller needs. A failed cleanup
      // leaves the unstarted list, which the account can delete later.
    }
  }

  private async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<JsonObject> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": "truelist-mcp/0.2.0",
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      body = options.body;
      if (options.contentType) {
        headers["Content-Type"] = options.contentType;
      }
    } else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 204) {
      return {};
    }

    const payload = await readPayload(response);
    if (response.ok) {
      return isJsonObject(payload) ? payload : {};
    }

    const code = normalizeCode(response.status, payload);
    throw new FinderApiError(code, errorMessage(payload, response.status), response.status);
  }
}

function listFilename(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  const raw = trimmed.length > 0 ? trimmed : "mcp-bulk-find.csv";
  const baseName = raw.split(/[/\\]/).pop() || raw;
  const sanitized = baseName.replace(/[^\w.\- ]+/g, "_");
  return sanitized.endsWith(".csv") ? sanitized : `${sanitized}.csv`;
}

function rowsToCsv(rows: FinderRowInput[]): string {
  const lines = [BULK_CSV_HEADERS.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [row.first_name, row.last_name, row.domain, row.email ?? ""]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvUpload(csv: string, filename: string): { body: string; contentType: string } {
  const boundary = `truelist-${Math.random().toString(16).slice(2)}`;
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    "Content-Type: text/csv",
    "",
    csv,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeCode(status: number, payload: unknown): string {
  const fromBody = readErrorCode(payload);
  if (fromBody === "payment_required" || (status === 402 && !fromBody)) {
    return "insufficient_credits";
  }
  if (fromBody) {
    return fromBody;
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "plan_not_supported";
  if (status === 404) return "not_found";
  if (status === 413) return "file_too_large";
  if (status === 429) return "rate_limited";
  if (status === 422) return "invalid_input";
  return "invalid_input";
}

function readErrorCode(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) {
    return undefined;
  }
  const code = payload.code ?? payload.error_code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function errorMessage(payload: unknown, status: number): string {
  if (isJsonObject(payload)) {
    const error = payload.error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    if (error !== undefined && error !== null) {
      return JSON.stringify(error);
    }
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }
  return `Request failed with status ${status}`;
}

function readCounts(value: unknown): Record<string, number> {
  if (!isJsonObject(value)) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const [status, count] of Object.entries(value)) {
    const parsed = typeof count === "number" ? count : Number(count);
    counts[status] = Number.isFinite(parsed) ? parsed : 0;
  }
  return counts;
}

function totalCount(
  counts: Record<string, number>,
  findStatus: string | undefined,
): number {
  if (findStatus) {
    return counts[findStatus] ?? 0;
  }
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function readString(value: JsonObject, key: string): string | undefined {
  const found = value[key];
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
