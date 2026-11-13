/**
 * Transport for a running DeepSeek Harness web server.
 *
 * Responsibilities:
 *  - spawn `dsh web` through processManager (or adopt a server we can prove we
 *    own: adoption only succeeds when this client keeps the launch token),
 *  - exchange the launch token for the peer cookie via `GET /connect`,
 *  - speak the HTTP RPC envelope (`POST /api/<endpoint>`),
 *  - multiplex logical streams over a single `/api/remote.mux` WebSocket,
 *  - reconnect with bounded exponential backoff and re-open every stream.
 *
 * This module must not depend on `vscode`; failures are raised as
 * {@link DshWebError} and logged through `src/log.ts`.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import WebSocket from 'ws';

import { log } from '../log';
import {
  resolveDshCommand,
  spawnRuntime,
  type SpawnedRuntime,
} from './processManager';

const TOKEN_LINE = /^dsh web:\s*(https?:\/\/\S+?)\/?\?token=([A-Za-z0-9_-]+)\s*$/;
const MUX_PATH = '/api/remote.mux';
const CONNECT_TIMEOUT_MS = 20_000;
const WS_OPEN_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_DEAD_MS = 20_000;
const MAX_RECONNECT_ATTEMPTS = 20;

/** True when something already accepts TCP connections on host:port. */
function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

/** Ask the OS for a free loopback port. */
function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Structured transport failure with a machine readable `code`. */
export class DshWebError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DshWebError';
    this.code = code;
    this.details = details;
  }
}

export interface WebClientOptions {
  host: string;
  port: number;
  reuseExisting: boolean;
  workspaceRoot: string;
  startTimeoutMs: number;
  debug: boolean;
  executable?: string;
  executableArgs?: string[];
  dshHome?: string;
  profile?: string;
  commandTimeoutMs?: number;
  /** Called when the transport gives up reconnecting or the child exits. */
  onExit?: (info: { code?: number; signal?: string; error?: string }) => void;
  /** Called after a successful reconnect, before streams are replayed. */
  onReconnect?: () => void;
  /** Called with the base URL once the server is reachable. */
  onReady?: (info: { baseUrl: string; adopted: boolean }) => void;
}

export interface RpcOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StreamHandlers {
  onItem?: (value: unknown) => void;
  onEnd?: () => void;
  onError?: (error: unknown) => void;
}

export interface StreamHandle {
  readonly streamId: string;
  readonly endpoint: string;
  /** Ask the server to cancel the logical stream and stop replaying it. */
  close(): void;
}

interface StreamRegistration {
  endpoint: string;
  args: Record<string, unknown>;
  handlers: StreamHandlers;
}

interface ServerFrame {
  type?: unknown;
  streamId?: unknown;
  value?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(raw: string | Buffer | ArrayBuffer | Buffer[]): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Client for a DSH web runtime. Create one, `await start()`, then issue RPCs
 * and open streams. `stop()` is idempotent and never kills an adopted server.
 */
export class WebClient {
  private readonly options: WebClientOptions;

  private port = 0;
  private baseUrl = '';
  private token = '';
  private cookie = '';
  private clientId = '';
  private adopted = false;

  private child: SpawnedRuntime | undefined;
  private ws: WebSocket | undefined;
  private started = false;
  private stopping = false;
  private reconnecting = false;
  private reconnectAttempts = 0;

  private readonly streams = new Map<string, StreamRegistration>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private lastActivity = 0;

  constructor(options: WebClientOptions) {
    this.options = options;
  }

  /** True while the multiplexer socket is open and no reconnect is pending. */
  isReady(): boolean {
    return (
      this.started &&
      !this.stopping &&
      !this.reconnecting &&
      this.ws?.readyState === WebSocket.OPEN
    );
  }

  /** Client id published by the `$events` stream's `ready` item. */
  getClientId(): string {
    return this.clientId;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getWorkspaceRoot(): string {
    return this.options.workspaceRoot;
  }

  getCommandTimeoutMs(): number {
    return this.options.commandTimeoutMs ?? 120_000;
  }

  /** Start (or verify) the server and attach the mux socket. */
  async start(): Promise<void> {
    if (this.started) return;

    this.port = this.options.port;
    if (await portInUse(this.options.host, this.port)) {
      if (!this.options.reuseExisting) {
        throw new DshWebError(
          'start/port-in-use',
          `Port ${this.options.host}:${this.options.port} is already in use. ` +
            'Set "dsh.port" to a free port, or enable "dsh.reuseExisting" to let the extension pick one.',
        );
      }
      // An existing server cannot be adopted: its launch token is never exposed.
      this.port = await findFreePort(this.options.host);
      log(
        'webClient: port',
        this.options.port,
        'is busy, starting the runtime on',
        this.port,
        'instead',
      );
    }

    await this.spawn();
    this.started = true;
    this.options.onReady?.({ baseUrl: this.baseUrl, adopted: this.adopted });
  }

  /** Close the socket and, when we spawned it, the server process tree. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.started = false;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;

    this.streams.clear();

    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {
        // socket already gone
      }
    }

    const child = this.child;
    this.child = undefined;
    if (child && child.child.pid && !this.adopted) {
      await this.killChild(child.child.pid);
    }
  }

  /**
   * Run one RPC call. The args object is sent verbatim as `payload.args`, so
   * callers pass the descriptor's parameter object (`{ request: ... }` or
   * `{ _request: ... }`).
   */
  async rpc<T>(
    endpoint: string,
    args: Record<string, unknown> = {},
    options: RpcOptions = {},
  ): Promise<T> {
    const rpcId = randomUUID();
    const body = {
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    } as const;

    let response = await this.postJson(endpoint, body, options);
    if (response.status === 401 || response.status === 403) {
      // The peer cookie is bound to the mux socket; after a socket drop it can
      // go stale. Re-exchange the launch token once and retry.
      await this.reauth();
      response = await this.postJson(endpoint, body, options);
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || payload.type !== 'server-response') {
      throw new DshWebError(
        'rpc/envelope',
        `Unexpected response for ${endpoint}: ${JSON.stringify(payload).slice(0, 300)}`,
      );
    }
    if (payload.rpcId !== rpcId) {
      throw new DshWebError('rpc/envelope', `Mismatched rpcId in response for ${endpoint}`);
    }
    const result = payload.result;
    if (!isRecord(result)) {
      throw new DshWebError('rpc/envelope', `Missing result for ${endpoint}`);
    }
    if (result.ok === true) {
      return result.value as T;
    }
    const error = isRecord(result.error) ? result.error : {};
    const code = typeof error.code === 'string' ? error.code : 'rpc/failed';
    const message =
      typeof error.message === 'string' ? error.message : `${endpoint} failed`;
    throw new DshWebError(code, message, error.details);
  }

  /**
   * Open a logical stream over the mux socket. Streams are replayed with the
   * same payload after a reconnect, so handlers must tolerate repeated items.
   */
  openStream(
    endpoint: string,
    args: Record<string, unknown>,
    handlers: StreamHandlers,
  ): StreamHandle {
    const streamId = randomUUID();
    this.streams.set(streamId, { endpoint, args, handlers });
    this.sendFrame({ type: 'open', streamId, endpoint, payload: { args } });

    return {
      streamId,
      endpoint,
      close: () => {
        if (!this.streams.delete(streamId)) return;
        this.sendFrame({ type: 'cancel', streamId });
      },
    };
  }

  // -- startup ------------------------------------------------------------

  private async spawn(): Promise<void> {
    const command = await resolveDshCommand({
      configuredExecutable: this.options.executable ?? '',
      configuredArgs: this.options.executableArgs ?? [],
      transportArgs: [],
      dshHome: this.options.dshHome,
      debug: this.options.debug,
    });

    const transportArgs = [
      '--profile',
      this.options.profile || 'web',
      '--port',
      String(this.port),
      '--no-open',
    ];
    log(
      'webClient: spawning',
      command.command,
      [...command.baseArgs, ...transportArgs].join(' '),
      `(source: ${command.source})`,
    );

    let stdout = '';
    let stderr = '';
    const launched = new Promise<string>((resolve, reject) => {
      const child = spawnRuntime(command, transportArgs, this.options.workspaceRoot);
      this.child = child;

      const timer = setTimeout(() => {
        reject(
          new DshWebError(
            'start/timeout',
            `dsh web did not announce a launch URL within ${this.options.startTimeoutMs}ms.` +
              tail(stderr),
          ),
        );
      }, Math.max(5_000, this.options.startTimeoutMs));

      const scan = (chunk: string): void => {
        if (this.token) return;
        const match = TOKEN_LINE.exec(chunk);
        if (match?.[1] && match[2]) {
          clearTimeout(timer);
          this.captureLaunchUrl(match[1], match[2]);
          resolve(this.token);
        }
      };

      child.child.stdout?.on('data', (data: Buffer) => {
        const text = stripAnsi(data.toString('utf8'));
        stdout = (stdout + text).slice(-65_536);
        if (this.options.debug) log('webClient: stdout', text.trimEnd());
        scan(stdout);
      });
      child.child.stderr?.on('data', (data: Buffer) => {
        const text = stripAnsi(data.toString('utf8'));
        stderr = (stderr + text).slice(-4_096);
        if (this.options.debug) log('webClient: stderr', text.trimEnd());
        // Some launchers print the ready line on stderr; the URL itself is not
        // secret beyond the token, which is still only used over loopback.
        scan(text);
      });
      child.child.on('error', (error) => {
        clearTimeout(timer);
        reject(new DshWebError('start/spawn', `Could not start dsh web: ${error.message}`));
      });
      child.child.on('exit', (code, signal) => {
        this.child = undefined;
        const detail = { code: code ?? undefined, signal: signal ?? undefined };
        if (!this.token) {
          clearTimeout(timer);
          reject(
            new DshWebError(
              'start/exit',
              `dsh web exited before announcing a launch URL (code ${String(code)}, signal ${String(
                signal,
              )}).${tail(stderr)}`,
              detail,
            ),
          );
          return;
        }
        if (this.stopping) return;
        log('webClient: dsh web process exited', detail);
        this.options.onExit?.({
          ...(code === null ? {} : { code }),
          ...(signal === null ? {} : { signal }),
        });
        this.scheduleReconnect();
      });
    });

    await launched;
    if (this.stopping) return;

    const cookie = await this.exchangeToken(this.token);
    await this.connectMux(cookie);
  }

  private captureLaunchUrl(url: string, token: string): void {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
      this.baseUrl = `${parsed.origin}${path}`;
    } catch {
      this.baseUrl = url.replace(/\/$/, '');
    }
    this.token = token;
    log('webClient: runtime announced', this.baseUrl);
  }

  // -- auth ---------------------------------------------------------------

  private async reauth(): Promise<string> {
    if (!this.token) {
      throw new DshWebError('auth/no-token', 'No launch token is available to re-authenticate.');
    }
    this.cookie = await this.exchangeToken(this.token);
    return this.cookie;
  }

  private async exchangeToken(token: string): Promise<string> {
    const url = `${this.baseUrl}/connect?token=${encodeURIComponent(token)}&interactions=answer`;
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        headers: { accept: '*/*' },
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DshWebError(
        'auth/network',
        `Could not reach ${this.baseUrl}/connect: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (response.status !== 302 && response.status !== 303) {
      const body = await response.text().catch(() => '');
      throw new DshWebError(
        'auth/status',
        `Token exchange returned HTTP ${response.status} instead of a redirect.${
          body ? ` ${body.slice(0, 200)}` : ''
        }`,
      );
    }

    const setCookie = response.headers.get('set-cookie');
    const pair = setCookie?.split(';')[0]?.trim() ?? '';
    if (!pair || !pair.includes('=')) {
      throw new DshWebError(
        'auth/cookie',
        'Token exchange succeeded but no set-cookie pair was returned.',
      );
    }
    return pair;
  }

  // -- websocket ----------------------------------------------------------

  private async connectMux(cookie: string): Promise<void> {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const url = `${wsBase}${MUX_PATH}`;
    this.cookie = cookie;

    const ws = new WebSocket(url, {
      headers: { cookie },
      perMessageDeflate: true,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new DshWebError('ws/timeout', `Timed out opening ${url}`));
      }, WS_OPEN_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
      };
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new DshWebError('ws/error', `WebSocket upgrade failed: ${error.message}`));
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });

    this.lastActivity = Date.now();
    this.reconnectAttempts = 0;
    ws.on('message', (data) => {
      this.lastActivity = Date.now();
      this.handleFrame(data);
    });
    ws.on('ping', () => {
      this.lastActivity = Date.now();
    });
    ws.on('pong', () => {
      this.lastActivity = Date.now();
    });
    ws.on('error', (error) => {
      log('webClient: mux socket error', error.message);
    });
    ws.on('close', (code, reason) => {
      if (this.stopping) return;
      log('webClient: mux socket closed', code, reason.toString());
      this.scheduleReconnect();
    });

    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {
        // socket dying, close handler will reconnect
      }
      if (Date.now() - this.lastActivity > HEARTBEAT_DEAD_MS) {
        log('webClient: heartbeat timed out, reconnecting');
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private sendFrame(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (error) {
      log('webClient: failed to send mux frame', error instanceof Error ? error.message : error);
    }
  }

  private handleFrame(raw: string | Buffer | ArrayBuffer | Buffer[]): void {
    let frame: ServerFrame;
    try {
      const parsed = JSON.parse(textOf(raw)) as unknown;
      if (!isRecord(parsed)) return;
      frame = parsed;
    } catch (error) {
      log('webClient: unparsable mux frame', error instanceof Error ? error.message : error);
      return;
    }
    if (typeof frame.type !== 'string' || typeof frame.streamId !== 'string') return;
    const registration = this.streams.get(frame.streamId);
    if (!registration) return;

    if (frame.type === 'item') {
      const value = frame.value;
      if (isRecord(value) && value.type === 'ready' && typeof value.clientId === 'string') {
        this.clientId = value.clientId;
      }
      registration.handlers.onItem?.(value);
      return;
    }
    if (frame.type === 'end') {
      this.streams.delete(frame.streamId);
      registration.handlers.onEnd?.();
      return;
    }
    if (frame.type === 'error') {
      this.streams.delete(frame.streamId);
      registration.handlers.onError?.(frame.error);
    }
  }

  private async reopenStreams(): Promise<void> {
    for (const [streamId, registration] of this.streams) {
      this.sendFrame({
        type: 'open',
        streamId,
        endpoint: registration.endpoint,
        payload: { args: registration.args },
      });
    }
    await Promise.resolve();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnecting || this.reconnectTimer) return;
    this.reconnecting = true;
    this.ws = undefined;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, 0);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.stopping) {
      this.reconnecting = false;
      return;
    }
    const token = this.token;
    if (!token) {
      this.reconnecting = false;
      this.options.onExit?.({ error: 'Lost the launch token; cannot reconnect.' });
      return;
    }

    while (!this.stopping && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const attempt = this.reconnectAttempts;
      this.reconnectAttempts += 1;
      const backoff = Math.min(30_000, 250 * 2 ** attempt);
      await sleep(backoff * (0.5 + Math.random() * 0.5));
      if (this.stopping) break;
      try {
        log(`webClient: reconnect attempt ${this.reconnectAttempts}`);
        const cookie = await this.exchangeToken(token);
        await this.connectMux(cookie);
        this.reconnecting = false;
        this.reconnectAttempts = 0;
        this.options.onReconnect?.();
        await this.reopenStreams();
        return;
      } catch (error) {
        log(
          'webClient: reconnect failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    this.reconnecting = false;
    if (!this.stopping) {
      this.options.onExit?.({
        error: `Could not reconnect to the agent runtime after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
      });
    }
  }

  // -- http ---------------------------------------------------------------

  private async postJson(
    endpoint: string,
    body: unknown,
    options: RpcOptions,
  ): Promise<Response> {
    if (!this.baseUrl || !this.cookie) {
      throw new DshWebError('rpc/not-ready', 'The agent runtime is not connected.');
    }
    const url = `${this.baseUrl}/api/${endpoint}`;
    const timeoutMs = options.timeoutMs ?? this.getCommandTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          cookie: this.cookie,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new DshWebError('rpc/aborted', `${endpoint} was aborted.`);
      }
      if (controller.signal.aborted) {
        throw new DshWebError(
          'rpc/timeout',
          `${endpoint} timed out after ${Math.round(timeoutMs / 1000)}s.`,
        );
      }
      throw new DshWebError(
        'rpc/network',
        `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  // -- shutdown -----------------------------------------------------------

  private async killChild(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        try {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('exit', () => resolve());
          killer.on('error', () => resolve());
        } catch {
          resolve();
        }
      });
      return;
    }

    const child = this.child?.child;
    childrenKill(child?.pid ?? pid);
    await sleep(250);
    childrenKill(child?.pid ?? pid, 'SIGKILL');
  }
}

function childrenKill(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return ` stderr: ${trimmed.slice(-500)}`;
}
