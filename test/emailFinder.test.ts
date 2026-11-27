import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BULK_COLUMN_MAP,
  EmailFinderClient,
  FinderApiError,
} from "../src/emailFinder.js";

const BASE = "https://api.test";

type Call = { url: URL; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit);
  };
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch): EmailFinderClient {
  return new EmailFinderClient("test-key", { baseUrl: BASE, fetch: fetchImpl });
}

function uploadBody(init: RequestInit): string {
  assert.equal(typeof init.body, "string");
  return String(init.body);
}

describe("findEmail", () => {
  it("posts the name and domain to the email finder endpoint", async () => {
    const { calls, fetchImpl } = mockFetch(async (url, init) => {
      assert.equal(url.pathname, "/api/v1/email_finder");
      assert.equal(init.method, "POST");
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer test-key",
      );
      assert.equal(init.body, JSON.stringify({
        first_name: "Jane",
        last_name: "Doe",
        domain: "example.com",
      }));
      return jsonResponse({
        status: "verified",
        domain: "example.com",
        best_match: { email: "jane@example.com" },
        credits_charged: 25,
      });
    });

    const result = await client(fetchImpl).findEmail({
      first_name: "Jane",
      last_name: "Doe",
      domain: "example.com",
    });

    assert.equal(calls.length, 1);
    assert.equal(result.status, "verified");
    assert.deepEqual(result.best_match, { email: "jane@example.com" });
  });
});

describe("startBulkFind", () => {
  it("uploads a csv then starts the run with the finder column map", async () => {
    const { calls, fetchImpl } = mockFetch(async (url, init) => {
      if (url.pathname.endsWith("/upload")) {
        const file = uploadBody(init);
        assert.match(
          String((init.headers as Record<string, string>)["Content-Type"]),
          /^multipart\/form-data; boundary=/,
        );
        assert.match(file, /filename="Q4 prospects.csv"/);
        assert.match(file, /First Name,Last Name,Domain,Email\n/);
        assert.match(file, /Jane,Doe,example.com,jane@example.com/);
        assert.match(file, /"Doe, Jr"/);
        return jsonResponse({ id: "list-1", name: "Q4 prospects.csv" }, 201);
      }
      assert.equal(url.pathname, "/api/v1/email_finder/bulk/list-1/start");
      assert.deepEqual(JSON.parse(String(init.body)), {
        map: BULK_COLUMN_MAP,
        credit_cap: 50,
      });
      return jsonResponse({
        id: "list-1",
        run: { id: "run-1", status: "running", credit_cap: 50 },
      }, 201);
    });

    const result = await client(fetchImpl).startBulkFind({
      name: "Q4 prospects",
      credit_cap: 50,
      rows: [
        {
          first_name: "Jane",
          last_name: "Doe",
          domain: "example.com",
          email: "jane@example.com",
        },
        {
          first_name: "Alex",
          last_name: "Doe, Jr",
          domain: "example.com",
        },
      ],
    });

    assert.equal(calls.length, 2);
    assert.equal(result.id, "list-1");
    assert.equal(result.name, "Q4 prospects.csv");
    assert.deepEqual(result.run, {
      id: "run-1",
      status: "running",
      credit_cap: 50,
    });
  });

  it("deletes the uploaded list when start fails", async () => {
    const { calls, fetchImpl } = mockFetch(async (url) => {
      if (url.pathname.endsWith("/upload")) {
        return jsonResponse({ id: "list-9", name: "mcp-bulk-find.csv" }, 201);
      }
      if (url.pathname.endsWith("/start")) {
        return jsonResponse(
          { error: "Cap is above the available balance.", code: "invalid_credit_cap" },
          422,
        );
      }
      assert.equal(url.pathname, "/api/v1/batches/list-9");
      return new Response(null, { status: 204 });
    });

    await assert.rejects(
      () =>
        client(fetchImpl).startBulkFind({
          credit_cap: 25,
          rows: [{ first_name: "Jane", last_name: "Doe", domain: "example.com" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof FinderApiError);
        assert.equal(error.code, "invalid_credit_cap");
        assert.match(error.message, /^invalid_credit_cap: /);
        return true;
      },
    );
    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url.pathname}`),
      [
        "POST /api/v1/email_finder/bulk/upload",
        "POST /api/v1/email_finder/bulk/list-9/start",
        "DELETE /api/v1/batches/list-9",
      ],
    );
  });
});

describe("getBulkFind", () => {
  it("reads the list and its latest run", async () => {
    const { fetchImpl } = mockFetch(async (url, init) => {
      assert.equal(init.method, "GET");
      assert.equal(url.pathname, "/api/v1/email_finder/bulk/list-1");
      return jsonResponse({
        id: "list-1",
        name: "Q4 prospects.csv",
        run: { status: "completed", credits_used: 25 },
      });
    });

    const result = await client(fetchImpl).getBulkFind("list-1");
    assert.equal(result.id, "list-1");
    assert.deepEqual(result.run, { status: "completed", credits_used: 25 });
  });
});

describe("listBulkFindResults", () => {
  it("turns the cursor pages into offset pages and keeps every status count", async () => {
    const counts = {
      not_processed: 0,
      skipped: 1,
      searching: 1,
      verified: 2,
      no_match: 1,
      no_confident_match: 0,
      no_mx: 0,
      invalid_input: 0,
      error: 0,
    };
    const rows = [1, 2, 3, 4, 5].map((csvLine) => ({
      csv_line: csvLine,
      found_email: csvLine === 1 ? "jane@example.com" : null,
    }));
    const { calls, fetchImpl } = mockFetch(async (url) => {
      assert.equal(url.pathname, "/api/v1/batches/list-1/finder_rows");
      const limit = Number(url.searchParams.get("limit"));
      const after = Number(url.searchParams.get("after") ?? -1);
      const page = rows.filter((row) => row.csv_line > after).slice(0, limit);
      const next = page.length === limit ? page[page.length - 1]?.csv_line : null;
      return jsonResponse({
        id: "list-1",
        rows: page,
        counts,
        next_after: next,
      });
    });

    const page = await client(fetchImpl).listBulkFindResults({
      list_id: "list-1",
      limit: 2,
      offset: 2,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url.searchParams.get("after"), null);
    assert.equal(calls[1]?.url.searchParams.get("after"), "2");
    assert.deepEqual(
      page.rows.map((row) => row.csv_line),
      [3, 4],
    );
    assert.equal(page.total_count, 5);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 2);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 4);
    assert.equal(page.counts.verified, 2);
    assert.equal(page.counts.no_match, 1);
    assert.equal(page.counts.skipped, 1);
    assert.equal(page.counts.searching, 1);
  });

  it("counts a filtered status and asks the API for that status", async () => {
    const { calls, fetchImpl } = mockFetch(async (url) => {
      assert.equal(url.searchParams.get("find_status"), "verified");
      return jsonResponse({
        rows: [{ csv_line: 1, found_email: "jane@example.com", find_status: "verified" }],
        counts: { verified: 1, no_match: 4, skipped: 0, searching: 0 },
        next_after: null,
      });
    });

    const page = await client(fetchImpl).listBulkFindResults({
      list_id: "list-1",
      find_status: "verified",
      limit: 25,
      offset: 0,
    });

    assert.equal(calls.length, 1);
    assert.equal(page.total_count, 1);
    assert.equal(page.has_more, false);
    assert.equal(page.next_offset, null);
    assert.equal(page.rows[0]?.found_email, "jane@example.com");
  });
});

describe("finder errors", () => {
  it("surfaces plan_not_supported, insufficient_credits, and rate_limited", async () => {
    const cases = [
      {
        status: 403,
        body: { error: "Email finder requires a paid v7 plan.", code: "plan_not_supported" },
        code: "plan_not_supported",
      },
      {
        status: 402,
        body: { error: "Fewer than 25 enhanced credits.", code: "insufficient_credits" },
        code: "insufficient_credits",
      },
      {
        status: 429,
        body: {
          error: "Rate limit exceeded. Please try again later.",
          error_code: "rate_limited",
        },
        code: "rate_limited",
      },
    ];

    for (const entry of cases) {
      const { calls, fetchImpl } = mockFetch(async () =>
        jsonResponse(entry.body, entry.status),
      );
      await assert.rejects(
        () =>
          client(fetchImpl).findEmail({
            first_name: "Jane",
            last_name: "Doe",
            domain: "example.com",
          }),
        (error: unknown) => {
          assert.ok(error instanceof FinderApiError);
          assert.equal(error.code, entry.code);
          assert.match(error.message, new RegExp(`^${entry.code}: `));
          assert.equal(error.message.includes("payment_required"), false);
          return true;
        },
      );
      assert.equal(calls.length, 1);
    }
  });

  it("reports a payment_required body as insufficient_credits", async () => {
    const { fetchImpl } = mockFetch(async () =>
      jsonResponse(
        { error: "Add a payment method.", code: "payment_required" },
        402,
      ),
    );

    await assert.rejects(
      () =>
        client(fetchImpl).findEmail({
          first_name: "Jane",
          last_name: "Doe",
          domain: "example.com",
        }),
      (error: unknown) => {
        assert.ok(error instanceof FinderApiError);
        assert.equal(error.code, "insufficient_credits");
        assert.match(error.message, /^insufficient_credits: /);
        assert.equal(error.message.includes("payment_required"), false);
        return true;
      },
    );
  });
});
