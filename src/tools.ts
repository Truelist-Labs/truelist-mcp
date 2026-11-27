import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Truelist from "truelist";
import {
  BULK_FIND_MAX_ROWS,
  BULK_RESULTS_DEFAULT_LIMIT,
  BULK_RESULTS_MAX_LIMIT,
  EmailFinderClient,
  FIND_CREDIT_PRICE,
  FIND_STATUSES,
  type JsonObject,
} from "./emailFinder.js";

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResult = Record<string, any>;

const FIND_EMAIL_DESCRIPTION = `Find a person's work email at a company domain.

WHAT THIS DOES:
Generates the common address patterns for the name at the domain and runs Truelist's enhanced validation to see which one is real. Returns the same fields as POST /api/v1/email_finder: status, the found address (best_match) when there is one, each pattern that was checked, and the credits charged.

status is verified, no_match, catch_all, or no_mx. best_match.email_state is the validation verdict for that address.

CREDIT USAGE:
A verified or no_match result costs ${FIND_CREDIT_PRICE} enhanced credits. catch_all, no_mx, and invalid input are free. Requires a paid v7 plan.

WHEN TO USE:
- One person. For a list, use start_bulk_find.

RELATED TOOLS: start_bulk_find, get_bulk_find, list_bulk_find_results`;

const START_BULK_FIND_DESCRIPTION = `Start an asynchronous bulk email find.

WHAT THIS DOES:
Stores the rows as a bulk find list and starts a run. The call returns as soon as the run is queued. It does not wait for addresses to be found. Poll get_bulk_find for progress, then page the rows with list_bulk_find_results.

CREDIT USAGE:
Each verified or no_match row costs ${FIND_CREDIT_PRICE} enhanced credits. Other outcomes are free, including skipped rows. credit_cap is the most this run may spend (at least ${FIND_CREDIT_PRICE}, and no more than the enhanced credits available). A row that already has an email is skipped. Requires a paid v7 plan.

WHEN TO USE:
- More than one person to find.
- You can wait and check back, rather than blocking on each name.

TYPICAL WORKFLOW:
1. start_bulk_find returns the list id and the running run.
2. get_bulk_find until run.status is no longer "running".
3. list_bulk_find_results to read each row.

RELATED TOOLS: get_bulk_find, list_bulk_find_results, find_email`;

const GET_BULK_FIND_DESCRIPTION = `Check the status and progress of a bulk email find.

WHAT THIS DOES:
Returns the list and its latest run: status, credit cap, credits used, and how many rows are eligible, processed, found, or still waiting. The find runs asynchronously after start_bulk_find. status "running" means it is still going.

Reading progress does not spend credits. A verified or no_match row still costs ${FIND_CREDIT_PRICE} enhanced credits when the run finds it; other outcomes are free. Requires a paid v7 plan.

WHEN TO USE:
- After start_bulk_find, to see whether the run has finished.

RELATED TOOLS: start_bulk_find, list_bulk_find_results`;

const LIST_BULK_FIND_RESULTS_DESCRIPTION = `Fetch the rows of a bulk email find, one page at a time.

WHAT THIS DOES:
Returns the list's rows in file order. Each row has its find status, the reason it was skipped or not processed, the credits charged, and found_email when the status is verified. found_email is only ever a verified address. counts is one integer for every find status (verified, no_match, skipped, searching, and the rest), on every page.

The find is asynchronous: rows appear as the run finishes them, and a running list returns the results so far. Pass offset back as next_offset until has_more is false.

A verified or no_match row costs ${FIND_CREDIT_PRICE} enhanced credits, charged when the run finds it. Other outcomes are free. Reading results does not spend credits. Requires a paid v7 plan.

WHEN TO USE:
- The run's status is no longer "running" and you need each address.
- You want one status, such as verified, via find_status.

RELATED TOOLS: get_bulk_find, start_bulk_find, find_email`;

function jsonText(value: JsonObject | BulkPage) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

type BulkPage = {
  id: string;
  total_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  counts: Record<string, number>;
  rows: JsonObject[];
};

const bulkFindRowSchema = z.object({
  first_name: z
    .string()
    .trim()
    .min(1)
    .describe("The person's first name."),
  last_name: z
    .string()
    .trim()
    .min(1)
    .describe("The person's last name."),
  domain: z
    .string()
    .trim()
    .min(1)
    .describe("The company domain."),
  email: z
    .string()
    .optional()
    .describe(
      "Optional. A row that already has an email is skipped and not charged.",
    ),
});

export function registerTools(
  server: McpServer,
  client: Truelist,
  finder: EmailFinderClient,
) {
  server.tool(
    "validate_email",
    "Validate an email address for deliverability using Truelist. Returns state (ok/email_invalid/risky/accept_all/unknown), sub_state, and metadata like domain, canonical, mx_record, first_name, last_name, and verified_at.",
    { email: z.string().email() },
    async ({ email }) => {
      const result: ApiResult = await client.email.validate(email);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                email,
                state: result.state,
                sub_state: result.subState,
                suggestion: result.suggestion,
                domain: result.domain,
                canonical: result.canonical,
                mx_record: result.mxRecord,
                first_name: result.firstName,
                last_name: result.lastName,
                verified_at: result.verifiedAt,
                is_valid: result.state === "ok",
                is_deliverable:
                  result.state === "ok" ||
                  result.state === "risky" ||
                  result.state === "accept_all",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "validate_emails",
    "Validate multiple email addresses for deliverability in a single batch. Returns an array of results with state and sub_state for each email. Maximum 50 emails per request.",
    { emails: z.array(z.string().email()).min(1).max(50) },
    async ({ emails }) => {
      const results: Array<{
        email: string;
        state: string;
        sub_state: string;
        is_valid: boolean;
        error?: string;
      }> = [];

      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        if (i > 0) {
          await sleep(BATCH_DELAY_MS);
        }

        const batch = emails.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (email) => {
            try {
              const result: ApiResult = await client.email.validate(email);
              return {
                email,
                state: result.state as string,
                sub_state: result.subState as string,
                is_valid: result.state === "ok",
              };
            } catch (err) {
              const message =
                err instanceof Error ? err.message : String(err);
              return {
                email,
                state: "unknown",
                sub_state: "unknown_error",
                is_valid: false,
                error: message,
              };
            }
          }),
        );
        results.push(...batchResults);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "check_account",
    "Check your Truelist account info including name, email, plan, and admin status.",
    {},
    async () => {
      const account = await client.account.get();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(account, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "find_email",
    {
      description: FIND_EMAIL_DESCRIPTION,
      inputSchema: {
        first_name: z
          .string()
          .trim()
          .min(1)
          .describe("The person's first name."),
        last_name: z
          .string()
          .trim()
          .min(1)
          .describe("The person's last name."),
        domain: z.string().trim().min(1).describe("The company domain."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ first_name, last_name, domain }) =>
      jsonText(await finder.findEmail({ first_name, last_name, domain })),
  );

  server.registerTool(
    "start_bulk_find",
    {
      description: START_BULK_FIND_DESCRIPTION,
      inputSchema: {
        rows: z
          .array(bulkFindRowSchema)
          .min(1)
          .max(BULK_FIND_MAX_ROWS)
          .describe(`1 to ${BULK_FIND_MAX_ROWS} people to find.`),
        credit_cap: z
          .number()
          .int()
          .min(FIND_CREDIT_PRICE)
          .describe(
            "Maximum enhanced credits this run may spend. At least 25, and no more than the enhanced credits available.",
          ),
        name: z
          .string()
          .optional()
          .describe("Optional name for the list."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ rows, credit_cap, name }) =>
      jsonText(await finder.startBulkFind({ rows, credit_cap, name })),
  );

  server.registerTool(
    "get_bulk_find",
    {
      description: GET_BULK_FIND_DESCRIPTION,
      inputSchema: {
        list_id: z
          .string()
          .trim()
          .min(1)
          .describe("The list id returned by start_bulk_find."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id }) => jsonText(await finder.getBulkFind(list_id)),
  );

  server.registerTool(
    "list_bulk_find_results",
    {
      description: LIST_BULK_FIND_RESULTS_DESCRIPTION,
      inputSchema: {
        list_id: z
          .string()
          .trim()
          .min(1)
          .describe("The list id returned by start_bulk_find."),
        find_status: z
          .enum(FIND_STATUSES)
          .optional()
          .describe("Optional. Only rows with this status."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(BULK_RESULTS_MAX_LIMIT)
          .default(BULK_RESULTS_DEFAULT_LIMIT)
          .describe("Page size. Default 25, maximum 100."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Number of matching rows to skip. Default 0."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ list_id, find_status, limit, offset }) =>
      jsonText(
        await finder.listBulkFindResults({
          list_id,
          find_status,
          limit,
          offset,
        }),
      ),
  );
}
