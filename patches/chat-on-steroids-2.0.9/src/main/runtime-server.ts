import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readDurable, writeDurableNow } from '../../../../src/main/durable.js';
import { logInfo, logWarn } from '../../../../src/main/logger.js';
import { listInputs } from '../../../../src/main/session/input.js';
import { sendDesktopInput } from '../../../../src/main/session/start-input.js';
import { createSession, getSession, readAsset, readRecentEvents } from '../../../../src/main/session/store.js';
import type { SessionEvent, StoredText } from '../../../../src/shared/session.js';

/*
 * Staged copy of the file to add as src/main/runtime-server.ts in Chat On Steroids 2.0.9.
 * The ../../../../ imports above are only so this artifact is self-describing in OmniRoute;
 * when copied into CoS src/main/, replace them with the sibling imports documented in
 * patches/chat-on-steroids-2.0.9/index.patch.
 */

const STATE = 'cos-runtime';
const MODEL = 'default';
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15 * 60_000;
const COMPLETE_TTL_MS = 24 * 60 * 60_000;

type Completion = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: typeof MODEL;
  choices: Array<{ index: 0; message: { role: 'assistant'; content: string }; finish_reason: 'stop' }>;
};

type RuntimeRequest = {
  inputId: string;
  status: 'inflight' | 'complete' | 'ambiguous';
  createdAt: number;
  updatedAt: number;
  response?: Completion;
  error?: string;
};

type RuntimeState = { sessionId?: string; requests: Record<string, RuntimeRequest> };

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'runtime_error') {
    super(message);
  }
}

let server: Server | null = null;
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

function enabled(): boolean {
  return process.env.COS_RUNTIME_ENABLED?.trim().toLowerCase() === 'true';
}

function token(): string {
  return process.env.COS_RUNTIME_TOKEN?.trim() ?? '';
}

function authorized(request: IncomingMessage): boolean {
  const expected = token();
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!expected || !presented) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(encoded.byteLength),
    'cache-control': 'no-store'
  });
  response.end(encoded);
}

function apiError(response: ServerResponse, status: number, message: string, code = 'runtime_error'): void {
  json(response, status, { error: { message, type: code, code } });
}

async function bodyJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large', 'request_too_large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON body', 'invalid_request_error');
  }
}

async function loadState(): Promise<RuntimeState> {
  const value = await readDurable<RuntimeState>(STATE);
  if (!value || typeof value !== 'object' || !value.requests || typeof value.requests !== 'object') {
    return { requests: {} };
  }
  return value;
}

function pruneCompleted(state: RuntimeState): RuntimeState {
  const cutoff = Date.now() - COMPLETE_TTL_MS;
  return {
    ...state,
    requests: Object.fromEntries(
      Object.entries(state.requests).filter(([, entry]) => entry.status !== 'complete' || entry.updatedAt >= cutoff)
    )
  };
}

async function saveState(state: RuntimeState): Promise<void> {
  await writeDurableNow(STATE, pruneCompleted(state));
}

async function ensureSession(state: RuntimeState): Promise<string> {
  const explicit = process.env.COS_RUNTIME_SESSION_ID?.trim();
  if (explicit) {
    if (!await getSession(explicit)) throw new HttpError(503, 'COS_RUNTIME_SESSION_ID does not exist', 'runtime_not_ready');
    return explicit;
  }
  if (state.sessionId && await getSession(state.sessionId)) return state.sessionId;
  const created = await createSession({ title: 'OmniRoute Runtime', conversationId: null });
  state.sessionId = created.id;
  await saveState(state);
  return created.id;
}

function digestKey(request: IncomingMessage): string {
  const header = request.headers['idempotency-key'];
  const value = typeof header === 'string' && header.trim() ? header.trim() : randomUUID();
  return createHash('sha256').update(value).digest('hex');
}

function flattenMessages(body: Record<string, unknown>): string {
  if (body.model !== MODEL) throw new HttpError(400, `Only model ${MODEL} is supported`, 'model_not_found');
  if (body.stream === true) throw new HttpError(400, 'Streaming is not supported yet', 'unsupported_feature');
  if (body.tools !== undefined || body.tool_choice !== undefined) {
    throw new HttpError(400, 'Tool payloads are not supported by the CoS runtime ingress', 'unsupported_feature');
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, 'messages must be a non-empty array', 'invalid_request_error');
  }
  const blocks: string[] = [];
  let hasUser = false;
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'Every message must be an object', 'invalid_request_error');
    }
    const message = raw as Record<string, unknown>;
    if (message.role !== 'system' && message.role !== 'user') {
      throw new HttpError(400, `Unsupported message role: ${String(message.role)}`, 'unsupported_feature');
    }
    if (typeof message.content !== 'string') {
      throw new HttpError(400, 'Only text message content is supported', 'unsupported_feature');
    }
    if (message.role === 'user') hasUser = true;
    blocks.push(`${message.role === 'system' ? 'System' : 'User'}:\n${message.content}`);
  }
  if (!hasUser) throw new HttpError(400, 'At least one user message is required', 'invalid_request_error');
  return blocks.join('\n\n').trim();
}

async function fullText(sessionId: string, value: StoredText): Promise<string> {
  if (!value.truncated || !value.assetId) return value.text;
  const asset = await readAsset(sessionId, value.assetId, 8 * 1024 * 1024);
  return asset ? asset.toString('utf8') : value.text;
}

function newest<T extends SessionEvent>(events: T[]): T | undefined {
  return [...events].sort((a, b) => a.seq - b.seq).at(-1);
}

async function waitForCompletion(sessionId: string, inputId: string): Promise<string> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let turnId: string | undefined;
  while (Date.now() < deadline) {
    const events = await readRecentEvents(sessionId, 1024, {
      kinds: ['user_message', 'assistant_message', 'turn_end'],
      maxBytes: 8 * 1024 * 1024
    });
    const user = newest(events.filter((event): event is Extract<SessionEvent, { kind: 'user_message' }> =>
      event.kind === 'user_message' && event.inputId === inputId));
    turnId = turnId ?? user?.turnId;
    if (turnId) {
      const end = newest(events.filter((event): event is Extract<SessionEvent, { kind: 'turn_end' }> =>
        event.kind === 'turn_end' && event.turnId === turnId));
      if (end) {
        if (end.outcome !== 'completed') {
          throw new Error(`ChatGPT turn ${turnId} ended as ${end.outcome}${end.detail ? `: ${end.detail}` : ''}`);
        }
        const assistant = newest(events.filter((event): event is Extract<SessionEvent, { kind: 'assistant_message' }> =>
          event.kind === 'assistant_message' && event.turnId === turnId && (event.final === true || event.state === 'final')));
        if (assistant) return fullText(sessionId, assistant.message);
      }
    }
    const entry = (await listInputs()).find(candidate => candidate.id === inputId);
    if (entry?.state === 'failed' || entry?.state === 'cancelled') throw new Error(entry.error || `Input ${entry.state}`);
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error(`Timed out waiting for the exact terminal turn after ${REQUEST_TIMEOUT_MS}ms`);
}

async function complete(request: IncomingMessage, body: Record<string, unknown>): Promise<Completion> {
  const text = flattenMessages(body);
  const key = digestKey(request);
  const state = await loadState();
  const previous = state.requests[key];
  if (previous?.status === 'complete' && previous.response) return previous.response;
  if (previous?.status === 'inflight' || previous?.status === 'ambiguous') {
    throw new HttpError(409, 'This idempotency key already owns an in-flight or ambiguous send; refusing to replay it', 'request_ambiguous');
  }

  const sessionId = await ensureSession(state);
  const inputId = randomUUID();
  state.requests[key] = { inputId, status: 'inflight', createdAt: Date.now(), updatedAt: Date.now() };
  await saveState(state);

  try {
    await sendDesktopInput({ id: inputId, sessionId, text, mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null });
  } catch (error) {
    const current = await loadState();
    delete current.requests[key];
    await saveState(current);
    throw error;
  }

  try {
    const answer = await waitForCompletion(sessionId, inputId);
    const response: Completion = {
      id: `chatcmpl-cos-${inputId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }]
    };
    const current = await loadState();
    current.requests[key] = { ...current.requests[key]!, status: 'complete', updatedAt: Date.now(), response };
    await saveState(current);
    return response;
  } catch (error) {
    const current = await loadState();
    current.requests[key] = {
      ...current.requests[key]!, status: 'ambiguous', updatedAt: Date.now(),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500)
    };
    await saveState(current);
    throw error;
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authorized(request)) return apiError(response, 401, 'Unauthorized', 'invalid_api_key');
  const url = new URL(request.url ?? '/', 'http://runtime.local');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    try {
      await serialize(async () => ensureSession(await loadState()));
      return json(response, 200, { ok: true, service: 'chat-on-steroids-runtime', version: '2.0.9', ready: true });
    } catch (error) {
      return json(response, 503, { ok: true, service: 'chat-on-steroids-runtime', version: '2.0.9', ready: false,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    return json(response, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'chat-on-steroids' }] });
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    try {
      const body = await bodyJson(request);
      return json(response, 200, await serialize(() => complete(request, body)));
    } catch (error) {
      return apiError(response, error instanceof HttpError ? error.status : 500,
        error instanceof Error ? error.message : 'Runtime request failed',
        error instanceof HttpError ? error.code : 'runtime_error');
    }
  }
  apiError(response, 404, 'Not found', 'not_found');
}

export async function startRuntimeServer(): Promise<boolean> {
  if (!enabled()) return false;
  if (server) return true;
  if (!token()) throw new Error('COS_RUNTIME_TOKEN is required when COS_RUNTIME_ENABLED=true');
  const host = process.env.COS_RUNTIME_HOST?.trim() || '127.0.0.1';
  const port = Number.parseInt(process.env.COS_RUNTIME_PORT || '8770', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COS_RUNTIME_PORT must be 1-65535');
  const next = createServer((request, response) => {
    void handle(request, response).catch(error => {
      logWarn(`runtime request: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) apiError(response, 500, 'Runtime request failed'); else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject);
    next.listen(port, host, () => { next.off('error', reject); resolve(); });
  });
  server = next;
  logInfo(`CoS runtime listening on ${host}:${port}`);
  return true;
}

export async function shutdownRuntimeServer(): Promise<void> {
  const current = server;
  server = null;
  if (!current) return;
  await new Promise<void>(resolve => current.close(() => resolve()));
}
