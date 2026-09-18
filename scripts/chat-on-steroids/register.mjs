#!/usr/bin/env node

const omniBaseUrl = requiredUrl("OMNIROUTE_BASE_URL");
const managementToken = required("OMNIROUTE_MANAGEMENT_TOKEN");
const cosRootUrl = requiredUrl("COS_RUNTIME_BASE_URL");
const cosToken = required("COS_RUNTIME_TOKEN");
const prefix = (process.env.COS_PROVIDER_PREFIX || "cos").trim();
const connectionName = (process.env.COS_PROVIDER_CONNECTION_NAME || "Chat On Steroids Runtime").trim();
const upstreamModel = (process.env.COS_RUNTIME_MODEL || "default").trim();
const publicModel = `${prefix}/${upstreamModel}`;
const cosV1 = `${cosRootUrl.replace(/\/v1$/i, "")}/v1`;
const timeoutMs = Number(process.env.COS_REGISTER_TIMEOUT_MS || 180_000);

if (!/^[a-z0-9][a-z0-9._-]*$/i.test(prefix)) fail(`Invalid COS_PROVIDER_PREFIX: ${prefix}`);
if (!upstreamModel || upstreamModel.includes("/")) {
  fail("COS_RUNTIME_MODEL must be an upstream model id without a provider prefix (default: default)");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function requiredUrl(name) {
  const value = required(name).replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be an absolute http(s) URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) fail(`${name} must use http or https`);
  return value;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}; received ${text.slice(0, 500)}`);
  }
}

async function request(url, { headers, ...init } = {}) {
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const detail = body?.error?.message || body?.error || body?.message || JSON.stringify(body);
    throw new Error(`${new URL(url).pathname} -> HTTP ${response.status}: ${detail}`);
  }
  return body;
}

const cosHeaders = {
  authorization: `Bearer ${cosToken}`,
  "content-type": "application/json",
};
const omniHeaders = {
  authorization: `Bearer ${managementToken}`,
  "content-type": "application/json",
};

async function probeCos() {
  const health = await request(`${cosRootUrl}/healthz`, { headers: cosHeaders });
  if (health?.ok !== true || health?.service !== "chat-on-steroids-runtime" || health?.ready !== true) {
    throw new Error(`CoS runtime is not ready: ${JSON.stringify(health)}`);
  }

  const models = await request(`${cosV1}/models`, { headers: cosHeaders });
  const ids = Array.isArray(models?.data) ? models.data.map((m) => m?.id).filter(Boolean) : [];
  if (!ids.includes(upstreamModel)) {
    throw new Error(`CoS /v1/models does not advertise upstream model ${upstreamModel}: ${JSON.stringify(ids)}`);
  }
  console.log(`CoS probe: ready; upstream model=${upstreamModel}`);
}

async function ensureNode() {
  const data = await request(`${omniBaseUrl}/api/provider-nodes?limit=500`, { headers: omniHeaders });
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const prefixed = nodes.filter((node) => node?.prefix === prefix);
  const exact = prefixed.find((node) => String(node?.baseUrl || "").replace(/\/$/, "") === cosV1);
  if (exact) {
    console.log(`OmniRoute provider node: reuse ${exact.id}`);
    return exact;
  }
  if (prefixed.length) {
    throw new Error(
      `Provider prefix ${prefix} already belongs to another node (${prefixed.map((n) => `${n.id}:${n.baseUrl}`).join(", ")}). Refusing to hijack it.`
    );
  }

  const created = await request(`${omniBaseUrl}/api/provider-nodes`, {
    method: "POST",
    headers: omniHeaders,
    body: JSON.stringify({
      name: "Chat On Steroids",
      prefix,
      apiType: "chat",
      type: "openai-compatible",
      baseUrl: cosV1,
      chatPath: "/chat/completions",
      modelsPath: "/models",
    }),
  });
  if (!created?.node?.id) throw new Error(`Provider-node creation returned no id: ${JSON.stringify(created)}`);
  console.log(`OmniRoute provider node: created ${created.node.id}`);
  return created.node;
}

async function listConnections() {
  const data = await request(`${omniBaseUrl}/api/providers?limit=500`, { headers: omniHeaders });
  return Array.isArray(data?.connections) ? data.connections : [];
}

async function ensureConnection(node) {
  const existing = (await listConnections()).filter((connection) => connection?.provider === node.id);
  if (existing.length > 1) {
    throw new Error(`Multiple OmniRoute connections already target ${node.id}; refusing to guess which one owns CoS`);
  }
  if (existing.length === 1) {
    console.log(`OmniRoute connection: reuse ${existing[0].id}`);
    return existing[0];
  }

  const created = await request(`${omniBaseUrl}/api/providers`, {
    method: "POST",
    headers: omniHeaders,
    body: JSON.stringify({
      provider: node.id,
      apiKey: cosToken,
      name: connectionName,
      priority: 1,
      defaultModel: upstreamModel,
    }),
  });
  if (!created?.connection?.id) throw new Error(`Provider creation returned no connection id: ${JSON.stringify(created)}`);
  console.log(`OmniRoute connection: created ${created.connection.id}`);
  return created.connection;
}

async function ensureParamFilters(connection) {
  const url = `${omniBaseUrl}/api/providers/${encodeURIComponent(connection.id)}/param-filters`;
  const existing = await request(url, { headers: omniHeaders });
  const block = Array.isArray(existing?.block)
    ? existing.block.filter((value) => typeof value === "string")
    : [];
  const allow = Array.isArray(existing?.allow)
    ? existing.allow.filter((value) => typeof value === "string")
    : [];
  const required = "max_tokens";
  if (!block.includes(required)) block.push(required);

  await request(url, {
    method: "PUT",
    headers: omniHeaders,
    body: JSON.stringify({
      block,
      allow,
      ...(existing?.models && typeof existing.models === "object" ? { models: existing.models } : {}),
      autoLearn: existing?.autoLearn === true,
    }),
  });
  console.log(`OmniRoute param filters: ${required} blocked for ${connection.id}`);
}

async function testConnection(connection) {
  const result = await request(`${omniBaseUrl}/api/providers/${encodeURIComponent(connection.id)}/test`, {
    method: "POST",
    headers: omniHeaders,
    body: JSON.stringify({ validationModelId: upstreamModel }),
  });
  if (result?.valid !== true && result?.skipped !== true) {
    throw new Error(`OmniRoute connection test failed: ${result?.error || JSON.stringify(result)}`);
  }
  console.log(`OmniRoute connection test: ${result?.valid === true ? "valid" : "unsupported/neutral"}`);
}

async function syncModels(connection) {
  const result = await request(
    `${omniBaseUrl}/api/providers/${encodeURIComponent(connection.id)}/sync-models?mode=import`,
    { method: "POST", headers: omniHeaders, body: "{}" }
  );
  const models = Array.isArray(result?.models) ? result.models : [];
  const ids = models.map((model) => model?.id).filter(Boolean);
  if (!ids.includes(upstreamModel)) {
    throw new Error(`OmniRoute model sync completed but did not import ${upstreamModel}: ${JSON.stringify(ids)}`);
  }
  console.log(`OmniRoute model sync: ${upstreamModel} imported`);
}

try {
  await probeCos();
  const node = await ensureNode();
  const connection = await ensureConnection(node);
  await ensureParamFilters(connection);
  await testConnection(connection);
  await syncModels(connection);
  console.log(`READY: select ${publicModel} in OmniRoute`);
  console.log("Automatic fallback was not modified.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/private|loopback|local|ssrf|base url/i.test(message)) {
    console.error("The CoS URL may be blocked by OmniRoute's private-upstream/SSRF guard. Use an operator-approved HTTPS/private-mesh endpoint; do not disable the guard globally.");
  }
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
