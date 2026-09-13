# Chat On Steroids runtime for OmniRoute

Status: **staged contract — not live until the CoS runtime ingress exists and passes the probe**.

This integration intentionally does **not** point OmniRoute at the existing Chat On Steroids browser bridge or MCP endpoint. Those endpoints have different identity and security semantics. Instead, CoS should expose one dedicated, authenticated OpenAI-compatible runtime listener that uses CoS's existing durable session/input machinery internally.

## Target topology

```text
client
  -> OmniRoute
     -> OpenAI-compatible custom provider: chat-on-steroids
        -> dedicated CoS runtime listener
           -> CoS sendDesktopInput()/durable outbox
              -> paired ChatGPT browser conversation
                 -> CoS recorder/session store
                    -> exact terminal assistant result
```

The first version should advertise a single logical model, `cos/default`. That route means "use the model/reasoning selection owned by the dedicated CoS runtime session". Do not pretend every ChatGPT account/model is available through the runtime. Model-specific routing can be added only after CoS can prove the requested account-observed model was selected for that exact send.

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

If the OmniRoute host is not on the same machine, publish this listener only through an authenticated private tunnel/mesh. Do not bind an unauthenticated runtime listener to `0.0.0.0`.

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
      "id": "cos/default",
      "object": "model",
      "owned_by": "chat-on-steroids"
    }
  ]
}
```

### `POST /v1/chat/completions`

Supported first-version request subset:

```json
{
  "model": "cos/default",
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

Successful response shape:

```json
{
  "id": "chatcmpl-cos-<request-id>",
  "object": "chat.completion",
  "created": 0,
  "model": "cos/default",
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

A caller may send `Idempotency-Key`. CoS should persist the mapping from that key to its input/request id before browser delivery. Repeating a completed key returns the recorded result; repeating an in-flight key attaches to the same request. It must never create a second browser send.

Start with concurrency **1 per dedicated CoS runtime session**. Additional parallelism should use separate CoS sessions and preserve their conversation/session identities independently.

## OmniRoute configuration

Once the ingress passes the probe, add it as an OpenAI-compatible custom provider rather than modifying the built-in provider registry:

```text
Provider name: Chat On Steroids
Base URL:      <private CoS runtime URL>/v1
API key:       same secret as COS_RUNTIME_TOKEN
Model:         cos/default
```

Keep the provider out of automatic fallback initially. Select `cos/default` explicitly until duplicate-send, disconnect, timeout, and cancellation tests pass.

The provider can join normal routing only after all acceptance tests below pass.

## Acceptance tests

1. **Health** — `/healthz` is authenticated and reports ready only when CoS can accept work.
2. **Basic turn** — `Return exactly COS_RUNTIME_OK` returns one final answer and one CoS user input.
3. **Session isolation** — two sequential requests are recorded under the intended dedicated runtime session without cross-session leakage.
4. **No duplicate on lost response** — force a connection drop after CoS accepts the input; retry with the same idempotency key and verify there is still one native user message.
5. **Browser unavailable** — request queues/fails truthfully; OmniRoute does not receive a fabricated completion.
6. **Timeout** — OmniRoute gets an error while CoS retains truthful request state; no automatic replay occurs.
7. **Cancellation** — cancellation affects only the exact active runtime request.
8. **Tool side effects** — run a harmless workspace task and verify it executes exactly once.
9. **Unsupported payload** — tool calls, images, or streaming are rejected until explicitly implemented.
10. **Authentication** — missing/wrong bearer token returns 401 and never creates a CoS input.

## Deployment gate for `omni.t3.group`

The current fork deployment mirrors the upstream OmniRoute image into `ghcr.io/shermzy/omniroute` by digest. Therefore changes on this branch do not automatically alter the running OmniRoute service, and this integration deliberately needs no OmniRoute core rebuild for the first version.

The live change is limited to adding the custom provider **after** the CoS runtime listener is reachable from the OmniRoute host and this repository's probe succeeds. Keep the existing OmniRoute image/routing unchanged until then.
