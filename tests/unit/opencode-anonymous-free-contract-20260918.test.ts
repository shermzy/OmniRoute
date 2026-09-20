// Live acceptance of this contract is performed by the hotfix workflow against omni.t3.group.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAnonymousFreeOpencodeHeaders,
} from "../../open-sse/utils/opencodeHeaders.ts";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";

const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

let originalSynthesis: string | undefined;

beforeEach(() => {
  originalSynthesis = process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS;
  process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS = "false";
});

afterEach(() => {
  if (originalSynthesis === undefined) delete process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS;
  else process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS = originalSynthesis;
});

test("anonymous free helper emits the OpenCode 1.18.31 wire identity", () => {
  const headers: Record<string, string> = {};
  applyAnonymousFreeOpencodeHeaders(headers, { "User-Agent": "curl/8.5.0" });

  assert.equal(headers["User-Agent"], "opencode/1.18.31");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-project"], "global");
  assert.match(headers["x-opencode-session"] ?? "", OPENCODE_SESSION_RE);
  assert.match(headers["x-opencode-request"] ?? "", OPENCODE_REQUEST_RE);
});

test("anonymous free helper preserves canonical OpenCode ids and project", () => {
  const headers: Record<string, string> = {};
  const session = "ses_0123456789ab0123456789ABCD";
  const request = "msg_abcdef012345ABCDEFGHIJKLMN";
  applyAnonymousFreeOpencodeHeaders(headers, {
    "x-opencode-session": session,
    "x-opencode-request": request,
    "x-opencode-project": "project-123",
  });

  assert.equal(headers["x-opencode-session"], session);
  assert.equal(headers["x-opencode-request"], request);
  assert.equal(headers["x-opencode-project"], "project-123");
});

test("keyless free Zen request uses Bearer public, canonical ids, CLI UA, and SSE accept", () => {
  const executor = new OpencodeExecutor("opencode");
  const headers = executor.buildHeaders(
    null,
    false,
    { "User-Agent": "curl/8.5.0" },
    "mimo-v2.5-free",
    undefined,
    {
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "OK" }],
    }
  );

  assert.equal(headers.Authorization, "Bearer public");
  assert.equal(headers.Accept, "text/event-stream");
  assert.equal(headers["User-Agent"], "opencode/1.18.31");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-project"], "global");
  assert.match(headers["x-opencode-session"] ?? "", OPENCODE_SESSION_RE);
  assert.match(headers["x-opencode-request"] ?? "", OPENCODE_REQUEST_RE);
});

test("keyed free Zen request keeps normal keyed auth and does not force anonymous identity", () => {
  const executor = new OpencodeExecutor("opencode");
  const headers = executor.buildHeaders(
    { apiKey: "real-key" },
    false,
    null,
    "mimo-v2.5-free"
  );

  assert.equal(headers.Authorization, "Bearer real-key");
  assert.equal(headers.Accept, undefined);
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["x-opencode-client"], undefined);
});

test("anonymous free Zen body is forced to streaming with a compatibility tool", () => {
  const executor = new OpencodeExecutor("opencode");
  const output = executor.transformRequest(
    "mimo-v2.5-free",
    {
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "Reply OK" }],
      stream: false,
    },
    false,
    {}
  );

  assert.equal(output.stream, true);
  assert.ok(Array.isArray(output.tools));
  assert.equal(output.tools.length, 1);
  assert.equal(output.tools[0]?.type, "function");
  assert.equal(output.tools[0]?.function?.name, "_noop");
});

test("keyed free Zen body is not rewritten into the anonymous free contract", () => {
  const executor = new OpencodeExecutor("opencode");
  const output = executor.transformRequest(
    "mimo-v2.5-free",
    {
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "Reply OK" }],
      stream: false,
    },
    false,
    { apiKey: "real-key" }
  );

  assert.equal(output.stream, false);
  assert.equal(output.tools, undefined);
});

test("opencode-go is never treated as anonymous free tier", () => {
  const executor = new OpencodeExecutor("opencode-go");
  const headers = executor.buildHeaders(null, false, null, "mimo-v2.5-free");

  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Accept, undefined);
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["x-opencode-session"], undefined);
});
