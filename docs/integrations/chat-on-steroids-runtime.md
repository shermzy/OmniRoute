# Chat On Steroids runtime for OmniRoute

Status: **registration tooling and a CoS 2.1.0 source patch are staged; live activation is gated on verification and the runtime ingress passing the probe**.

The staged CoS source is pinned to `totec448-spec/chat-on-steroids` commit `1517d66dac1e7452f63b7452c88479c92a554768` (package version 2.1.0).

This integration intentionally does **not** point OmniRoute at the existing Chat On Steroids browser bridge or MCP endpoint. Those endpoints have different identity and security semantics. Instead, CoS gets one dedicated, authenticated OpenAI-compatible runtime listener that uses CoS's existing durable session/input machinery internally.

## Target topology

```text
client
  -> OmniRoute model cos/default
     -> OpenAI-compatible custom node (prefix: cos)
        -> dedicated CoS runtime listener model default
           -> CoS sendDesktopInput()/durable outbox
              -> paired ChatGPT browser conversation
                 -> CoS recorder/session store
                    -> exact terminal assistant result
```

The first version has two model identities on purpose:

- CoS upstream model id: `default`
- OmniRoute public model id: `cos/default`

The OmniRoute compatible-node prefix supplies `cos/`; CoS must not advertise a second `cos/` prefix itself. `default` means "use the model/reasoning selection owned by the dedicated CoS runtime session". Do not pretend every ChatGPT account/model is available through the runtime. Model-specific routing can be added only after CoS can prove the requested account-observed model was selected for that exact send.

## Required CoS ingress contract

The listener is a **new runtime surface** with its own bearer token. It must not weaken browser-pairing, MCP caller attribution, approved-root checks, or the browser bridge's loopback-only assumptions.

Environment owned by CoS:

```text
COS_RUNTIME_ENABLED=true
COS_RUNTIME_HOST=127.0.0.1
COS_RUNTIME_PORT=8770
COS_RUNTIME_TOKEN=<random high-entropy secret>
COS_RUNTIME_SESSION_ID=<optional dedicated existing session id>
```

If the OmniRoute host is not on the same machine, publish this listener only through an operator-approved authenticated private tunnel/mesh or HTTPS endpoint. Do not bind an unauthenticated runtime listener to `0.0.0.0`, and do not globally weaken OmniRoute's private-upstream/SSRF guard merely to make this route work.

### `GET /healthz`

Authenticated health response:

```json
{
  "ok": true,
  "service": "chat-on-steroids-runtime",
  "version": "2.1.0",
  "ready": true
}
```

`ready` must be false unless CoS can resolve/create its dedicated durable runtime session. Browser delivery still has its own truthful delivery state; health never claims a request was delivered merely because the listener exists.

### `GET /v1/models`

Initial response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "default",
      "object": "model",
      "owned_by": "chat-on-steroids"
    }
  ]
}
```

OmniRoute discovers/imports this upstream `default` model under the node prefix `cos`, making the client-facing model `cos/default`.

### `POST /v1/chat/completions`

Supported first-version request subset:

```json
{
  "model": "default",
  "messages": [
    { "role": "system", "content": "optional instructions" },
    { "role": "user", "content": "task" }
  ],
  "stream": false
}
```

Initial implementation rules:

1. Reject `stream: true` with a normal OpenAI-compatible 4xx error until CoS has a truthful streaming boundary.
2. Flatten only supported text `system`/`user` messages into one authored runtime request. Reject unsupported multimodal/tool/assistant payloads rather than silently dropping them.
3. Create a UUID request/input id and call the same `sendDesktopInput()` path used by explicit desktop sends. Do not write directly to the browser bridge.
4. Use a dedicated CoS session, or create one through the existing session store. Reuse is serialized at first (one active OmniRoute request per runtime listener).
5. After the durable input is accepted, correlate the canonical `user_message.inputId` to its exact `turnId`, require a matching completed `turn_end`, and return only the final assistant message for that turn.
6. Resolve a truncated final message from its recorded asset rather than returning only the inline prefix.
7. If delivery becomes ambiguous after CoS has published the durable send, preserve the idempotency reservation and fail rather than automatically replaying it. A replay could duplicate file edits or commands.
8. Missing/wrong bearer tokens are rejected before any runtime input is created.

## Idempotency and concurrency

A caller may send `Idempotency-Key`. CoS hashes the key before durable storage. A completed key returns the same recorded completion id/result. An in-flight or ambiguous key returns conflict and must never create a second browser send.

The first version serializes runtime requests. Additional parallelism should use separate explicitly-owned CoS sessions and preserve conversation/session identities independently.

## Apply the staged CoS 2.1.0 source

From this OmniRoute branch, point the installer at a **writable** CoS 2.1.0 checkout:

```bash
COS_SOURCE_DIR=/path/to/chat-on-steroids \
node scripts/chat-on-steroids/install-cos-source.mjs
```

The installer validates package version 2.1.0, refuses to overwrite a different existing `runtime-server.ts`, and patches three exact `src/main/index.ts` anchors for import/start/shutdown. CI applies the same installer to pinned commit `1517d66dac1e7452f63b7452c88479c92a554768`, confirms its pre-existing `search.test.ts` `filesScanned` baseline failure before patching, asserts that only `src/main/index.ts` and `src/main/runtime-server.ts` change, typechecks the patched tree, and runs every other upstream test.

Then build/package/install CoS through its normal release path with the runtime environment variables above.

## Probe the CoS ingress

Run this on a host that can reach the CoS runtime:

```bash
COS_RUNTIME_BASE_URL=http://127.0.0.1:8770 \
COS_RUNTIME_TOKEN='...' \
node scripts/chat-on-steroids/probe.mjs
```

The probe checks authenticated health, `default` model discovery, an exact completion, and idempotent replay using the same completion id.

## Register it in OmniRoute

After the probe passes, register the runtime through OmniRoute's existing compatible-provider management APIs:

```bash
OMNIROUTE_BASE_URL=https://omni.t3.group \
OMNIROUTE_MANAGEMENT_TOKEN='...' \
COS_RUNTIME_BASE_URL='https://<operator-approved-cos-endpoint>' \
COS_RUNTIME_TOKEN='...' \
node scripts/chat-on-steroids/register.mjs
```

`register.mjs` is idempotent and deliberately conservative. It:

1. Probes CoS health and verifies upstream model `default`.
2. Reuses the exact `cos` provider node if it already targets the same CoS `/v1` endpoint.
3. Refuses to hijack `cos` if that prefix already belongs to another node.
4. Creates an OpenAI-compatible chat node with `/chat/completions` and `/models` paths only when necessary.
5. Reuses the sole connection for that node or creates one with the CoS bearer token and upstream default model `default`.
6. Runs OmniRoute's own connection test and imports the live model catalog.
7. Leaves automatic fallback unchanged.

On success it prints:

```text
READY: select cos/default in OmniRoute
Automatic fallback was not modified.
```

If OmniRoute rejects the CoS base URL under its private-upstream/SSRF policy, publish CoS through an operator-approved reachable endpoint. Do **not** globally disable that protection.

## Acceptance tests

1. **Health** — `/healthz` is authenticated and reports ready only when the durable runtime session is available.
2. **Basic turn** — `Return exactly COS_RUNTIME_OK` returns one final answer and one CoS user input.
3. **Session isolation** — sequential requests are recorded under the intended dedicated runtime session without cross-session leakage.
4. **No duplicate on lost response** — force a connection drop after CoS accepts the input; retry with the same idempotency key and verify there is still one native user message and no second send.
5. **Browser unavailable** — request fails/queues truthfully; OmniRoute does not receive a fabricated completion.
6. **Timeout** — OmniRoute gets an error while CoS retains ambiguous request state; no automatic replay occurs.
7. **Tool side effects** — run a harmless workspace task and verify it executes exactly once.
8. **Unsupported payload** — tool calls, images, assistant-history payloads, or streaming are rejected until explicitly implemented.
9. **Authentication** — missing/wrong bearer token returns 401 and never creates a CoS input.
10. **Static verification** — the pinned CoS tree's known `search.test.ts` baseline is established before patching; the runtime patch is scope-checked, typechecked, and the unaffected upstream suite passes.

## Deployment gate for `omni.t3.group`

The current fork deployment mirrors the upstream OmniRoute image into `ghcr.io/shermzy/omniroute` by digest. Therefore changes on this branch do not automatically alter the running OmniRoute service. The first integration does not require an OmniRoute core rebuild: it uses the already-shipped custom-provider management surface.

The live mutation is limited to adding the compatible provider node/connection **after** the CoS runtime listener is reachable from the OmniRoute host and the probe succeeds. Keep the existing routing unchanged until then.
