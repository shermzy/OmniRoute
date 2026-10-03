#!/usr/bin/env node

const baseUrl = (process.env.COS_RUNTIME_BASE_URL || "").replace(/\/$/, "");
const token = process.env.COS_RUNTIME_TOKEN || "";
const model = (process.env.COS_RUNTIME_MODEL || "default").trim();

if (!baseUrl) {
  console.error("COS_RUNTIME_BASE_URL is required, e.g. http://127.0.0.1:8770");
  process.exit(2);
}
if (!token) {
  console.error("COS_RUNTIME_TOKEN is required");
  process.exit(2);
}
if (!model || model.includes("/")) {
  console.error("COS_RUNTIME_MODEL must be an upstream model id without an OmniRoute prefix (default: default)");
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

async function checkedError(path, expectedStatus, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers || {}) },
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  const body = await readJson(response);
  if (response.status !== expectedStatus) {
    throw new Error(`${path} -> expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`);
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
const ids = Array.isArray(models?.data) ? models.data.map((entry) => entry?.id) : [];
if (!ids.includes(model)) {
  throw new Error(`${model} missing from model list: ${JSON.stringify(ids)}`);
}
console.log(`models: ${model} present`);

const unsupported = await checkedError("/v1/chat/completions", 400, {
  method: "POST",
  headers: { "idempotency-key": `omniroute-cos-unsupported-${Date.now()}` },
  body: JSON.stringify({
    model,
    stream: false,
    max_tokens: 8,
    messages: [{ role: "user", content: "This request must be rejected before browser delivery." }],
  }),
});
if (unsupported?.error?.code !== "unsupported_parameter") {
  throw new Error(`Unexpected unsupported-parameter response: ${JSON.stringify(unsupported)}`);
}
console.log("compatibility: max_tokens rejected at direct CoS ingress");

const idem = `omniroute-cos-probe-${Date.now()}`;
const body = JSON.stringify({
  model,
  stream: false,
  messages: [{ role: "user", content: "Return exactly COS_RUNTIME_OK" }],
});
const completion = await checked("/v1/chat/completions", {
  method: "POST",
  headers: { "idempotency-key": idem },
  body,
});
const answer = completion?.choices?.[0]?.message?.content;
if (answer !== "COS_RUNTIME_OK") {
  throw new Error(`Unexpected completion: ${JSON.stringify(completion)}`);
}
console.log("completion: COS_RUNTIME_OK");

const replay = await checked("/v1/chat/completions", {
  method: "POST",
  headers: { "idempotency-key": idem },
  body,
});
const replayAnswer = replay?.choices?.[0]?.message?.content;
if (replayAnswer !== "COS_RUNTIME_OK") {
  throw new Error(`Idempotent replay mismatch: ${JSON.stringify(replay)}`);
}
if (replay?.id !== completion?.id) {
  throw new Error(`Idempotent replay created a different completion id: ${completion?.id} -> ${replay?.id}`);
}
console.log("idempotency: replay returned the same completion id/result");
console.log("probe: PASS");
