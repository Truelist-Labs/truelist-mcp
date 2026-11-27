import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Truelist from "truelist";
import {
  EmailFinderClient,
  FIND_STATUSES,
} from "../src/emailFinder.js";
import { registerTools } from "../src/tools.js";

async function connect(fetchImpl: typeof fetch) {
  const server = new McpServer({ name: "truelist", version: "0.2.0" });
  registerTools(
    server,
    new Truelist("test-key"),
    new EmailFinderClient("test-key", {
      baseUrl: "https://api.test",
      fetch: fetchImpl,
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

function toolText(result: unknown): string {
  assert.ok(result && typeof result === "object" && "content" in result);
  const content = result.content;
  assert.ok(Array.isArray(content));
  const block = content[0] as { type?: string; text?: string } | undefined;
  assert.equal(block?.type, "text");
  assert.equal(typeof block?.text, "string");
  return block?.text ?? "";
}

describe("email finder tools", () => {
  it("lists the four tools with the finder input schema", async () => {
    const client = await connect(async () => {
      throw new Error("schema listing does not call the API");
    });
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));

    const findEmail = tools.get("find_email");
    assert.ok(findEmail);
    assert.deepEqual(findEmail.inputSchema.required, [
      "first_name",
      "last_name",
      "domain",
    ]);
    assert.equal(findEmail.annotations?.destructiveHint, true);
    assert.equal(findEmail.annotations?.readOnlyHint, false);

    const start = tools.get("start_bulk_find");
    assert.ok(start);
    assert.deepEqual(start.inputSchema.required, ["rows", "credit_cap"]);
    const rows = start.inputSchema.properties?.rows as {
      minItems?: number;
      maxItems?: number;
      items?: { required?: string[] };
    };
    assert.equal(rows.minItems, 1);
    assert.equal(rows.maxItems, 10000);
    assert.deepEqual(rows.items?.required, ["first_name", "last_name", "domain"]);
    const creditCap = start.inputSchema.properties?.credit_cap as {
      minimum?: number;
      type?: string;
    };
    assert.equal(creditCap.minimum, 25);
    assert.equal(creditCap.type, "integer");

    const progress = tools.get("get_bulk_find");
    assert.ok(progress);
    assert.deepEqual(progress.inputSchema.required, ["list_id"]);
    assert.equal(progress.annotations?.readOnlyHint, true);

    const results = tools.get("list_bulk_find_results");
    assert.ok(results);
    assert.deepEqual(results.inputSchema.required, ["list_id"]);
    const findStatus = results.inputSchema.properties?.find_status as {
      enum?: string[];
    };
    assert.deepEqual(findStatus.enum, [...FIND_STATUSES]);
    const limit = results.inputSchema.properties?.limit as {
      minimum?: number;
      maximum?: number;
      default?: number;
    };
    assert.equal(limit.minimum, 1);
    assert.equal(limit.maximum, 100);
    assert.equal(limit.default, 25);
    const offset = results.inputSchema.properties?.offset as { default?: number };
    assert.equal(offset.default, 0);
    await client.close();
  });

  it("returns the finder JSON and the API error code", async () => {
    const client = await connect(async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/v1/email_finder" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            status: "verified",
            best_match: { email: "jane@example.com" },
            credits_charged: 25,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          error: "Email finder requires a paid v7 plan.",
          code: "plan_not_supported",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    });

    const found = await client.callTool({
      name: "find_email",
      arguments: {
        first_name: "Jane",
        last_name: "Doe",
        domain: "example.com",
      },
    });
    assert.equal(found.isError, undefined);
    assert.match(toolText(found), /jane@example.com/);

    const refused = await client.callTool({
      name: "get_bulk_find",
      arguments: { list_id: "list-1" },
    });
    assert.equal(refused.isError, true);
    assert.match(toolText(refused), /^plan_not_supported: /);
    assert.equal(toolText(refused).includes("payment_required"), false);

    const invalid = await client.callTool({
      name: "find_email",
      arguments: { last_name: "Doe", domain: "example.com" },
    });
    assert.equal(invalid.isError, true);
    await client.close();
  });
});
