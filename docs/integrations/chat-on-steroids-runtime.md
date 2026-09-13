# Chat On Steroids runtime for OmniRoute

Status: **registration tooling is staged; live activation is gated on the CoS runtime ingress passing the probe**.

This integration intentionally does **not** point OmniRoute at the existing Chat On Steroids browser bridge or MCP endpoint. Those endpoints have different identity and security semantics. Instead, CoS should expose one dedicated, authenticated OpenAI-compatible runtime listener that uses CoS's existing durable session/input machinery internally.

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

The listener must be a **new runtime surface** with its own bearer token. It must not weaken browser-pairing, MCP caller attribution, approved-root checks, or the browser bridge's loopback-only assumptions.

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
  "version": "2.0.9",
  "ready": true
}
```

`ready` must be false unless CoS can accept a durable input. Browser/connector unavailability may be reported separately, but health must never claim a request was delivered merely because it was queued.

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
2. Flatten only supported text messages into one authored runtime request. Reject unsupported multimodal/tool payloads rather than silently dropping them.
3. Create a UUID request/input id and call the same `sendDesktopInput()` path used by explicit desktop sends. Do not write directly to the browser bridge.
4. Use a dedicated CoS session, or create one through the existing session store. Reuse must be serialized at first (one active OmniRoute request per runtime session).
5. After the durable input is accepted, wait for the exact turn associated with that input to reach a terminal `turn_end` and for its canonical assistant message to be final.
6. Return only that exact assistant message. Interim prose, a queued input, a browser click, or an ambiguous ACK is not completion.
7. If delivery becomes ambiguous after CoS has claimed the browser send, fail the API request without automatically replaying it. A replay could duplicate file edits or commands.
8. Propagate cancellation to CoS only when CoS can prove cancellation belongs to the same request/input id.

Successful upstream response shape:

```json
{
  "id": "chatcmpl-cos-<request-id>",
  "object": "chat.completion",
  "created": 0,
  "model": "default",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ]
}
```

Token usage may be omitted or returned as unknown until CoS has trustworthy request-level usage accounting.

## Idempotency and concurrency

A caller may send `Idempotency-Key`. CoS should persist the mapping from that key to its input/request id before browser delivery. Repeating a completed key returns the same recorded completion id/result; repeating an in-flight key attaches to the same request. It must never create a second browser send.

Start with concurrency **1 per dedicated CoS runtime session**. Additional parallelism should use separate CoS sessions and preserve their conversation/session identities independently.

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

1. **Health** — `/healthz` is authenticated and reports ready only when CoS can accept work.
2. **Basic turn** — `Return exactly COS_RUNTIME_OK` returns one final answer and one CoS user input.
3. **Session isolation** — two sequential requests are recorded under the intended dedicated runtime session without cross-session leakage.
4. **No duplicate on lost response** — force a connection drop after CoS accepts the input; retry with the same idempotency key and verify there is still one native user message and the same completion id.
5. **Browser unavailable** — request queues/fails truthfully; OmniRoute does not receive a fabricated completion.
6. **Timeout** — OmniRoute gets an error while CoS retains truthful request state; no automatic replay occurs.
7. **Cancellation** — cancellation affects only the exact active runtime request.
8. **Tool side effects** — run a harmless workspace task and verify it executes exactly once.
9. **Unsupported payload** — tool calls, images, or streaming are rejected until explicitly implemented.
10. **Authentication** — missing/wrong bearer token returns 401 and never creates a CoS input.

## Deployment gate for `omni.t3.group`

The current fork deployment mirrors the upstream OmniRoute image into `ghcr.io/shermzy/omniroute` by digest. Therefore changes on this branch do not automatically alter the running OmniRoute service. The first integration does not require an OmniRoute core rebuild: it uses the already-shipped custom-provider management surface.

The live mutation is limited to adding the compatible provider node/connection **after** the CoS runtime listener is reachable from the OmniRoute host and the probe succeeds. Keep the existing routing unchanged until then.
