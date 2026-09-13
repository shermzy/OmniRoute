#!/usr/bin/env node

const baseUrl = (process.env.COS_RUNTIME_BASE_URL || "").replace(/\/$/, "");
const token = process.env.COS_RUNTIME_TOKEN || "";

if (!baseUrl) {
  console.error("COS_RUNTIME_BASE_URL is required, e.g. http://127.0.0.1:8770");
  process.exit(2);
}
if (!token) {
  console.error("COS_RUNTIME_TOKEN is required");
  process.exit(2);
}

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${response.url}; got ${text.slice(0, 500)}`);
  }
}

async function checked(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers || {}) },
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const health = await checked("/healthz");
if (health?.ok !== true || health?.service !== "chat-on-steroids-runtime") {
  throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
}
if (health?.ready !== true) {
  throw new Error(`CoS runtime is not ready: ${JSON.stringify(health)}`);
}
console.log(`health: ok (version=${health.version ?? "unknown"})`);

const models = await checked("/v1/models");
const ids = Array.isArray(models?.data) ? models.data.map((model) => model?.id) : [];
if (!ids.includes("cos/default")) {
  throw new Error(`cos/default missing from model list: ${JSON.stringify(ids)}`);
}
console.log("models: cos/default present");

const idem = `omniroute-cos-probe-${Date.now()}`;
const completion = await checked("/v1/chat/completions", {
  method: "POST",
  headers: { "idempotency-key": idem },
  body: JSON.stringify({
    model: "cos/default",
    stream: false,
    messages: [{ role: "user", content: "Return exactly COS_RUNTIME_OK" }],
  }),
});
const answer = completion?.choices?.[0]?.message?.content;
if (answer !== "COS_RUNTIME_OK") {
  throw new Error(`Unexpected completion: ${JSON.stringify(completion)}`);
}
console.log("completion: COS_RUNTIME_OK");

const replay = await checked("/v1/chat/completions", {
  method: "POST",
  headers: { "idempotency-key": idem },
  body: JSON.stringify({
    model: "cos/default",
    stream: false,
    messages: [{ role: "user", content: "Return exactly COS_RUNTIME_OK" }],
  }),
});
const replayAnswer = replay?.choices?.[0]?.message?.content;
if (replayAnswer !== "COS_RUNTIME_OK") {
  throw new Error(`Idempotent replay mismatch: ${JSON.stringify(replay)}`);
}
console.log("idempotency: replay returned same logical result");
console.log("probe: PASS");
