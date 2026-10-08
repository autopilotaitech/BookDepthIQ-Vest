import {
  WS_URL,
  parseChannel,
  streamName,
  type DepthMsg,
  type StreamKind,
  type TickerMsg,
  type TradeMsg,
} from './types.js';

// Minimal WebSocket surface shared by the browser's WebSocket and the `ws` package, so the same
// client runs in the panel (browser) and the probe (Node).
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', fn: (ev: unknown) => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}
export type SocketFactory = (url: string) => SocketLike;
const OPEN = 1;

const defaultFactory: SocketFactory = (url) =>
  new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url);

// Read-only market-data socket. Subscribes, pings, reconnects with backoff and re-subscribes
// everything after a reconnect. It never sends anything but SUBSCRIBE / UNSUBSCRIBE / PING.

export interface MarketHandlers {
  onDepth?(symbol: string, msg: DepthMsg): void;
  onTrade?(symbol: string, msg: TradeMsg): void;
  onTicker?(symbol: string, msg: TickerMsg): void;
  /** A requested stream the server refused (it answers per stream: "registered" / "rejected"). */
  onRejected?(stream: string, reason: string): void;
  onStatus?(status: 'open' | 'closed', detail?: string): void;
}

const PING_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

export class VestMarketSocket {
  private ws: SocketLike | null = null;
  private streams = new Set<string>();
  private nextId = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1_000;
  private stopped = false;

  constructor(
    private readonly handlers: MarketHandlers,
    private readonly url = WS_URL,
    private readonly factory: SocketFactory = defaultFactory,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  subscribe(symbol: string, kinds: StreamKind[]): void {
    const fresh = kinds.map((k) => streamName(symbol, k)).filter((s) => !this.streams.has(s));
    for (const s of fresh) this.streams.add(s);
    if (fresh.length) this.send('SUBSCRIBE', fresh);
  }

  unsubscribe(symbol: string, kinds: StreamKind[]): void {
    const gone = kinds.map((k) => streamName(symbol, k)).filter((s) => this.streams.delete(s));
    if (gone.length) this.send('UNSUBSCRIBE', gone);
  }

  private connect(): void {
    const ws = this.factory(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.backoffMs = 1_000;
      this.handlers.onStatus?.('open');
      if (this.streams.size) this.send('SUBSCRIBE', [...this.streams]);
      this.clearPing();
      this.pingTimer = setInterval(() => this.send('PING', []), PING_MS);
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws === ws) this.dispatch(String(ev.data));
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return; // a socket we already replaced or stopped
      this.clearPing();
      this.ws = null;
      this.handlers.onStatus?.('closed', 'socket closed');
      if (this.stopped) return;
      const wait = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      setTimeout(() => !this.stopped && this.connect(), wait);
    });
    ws.addEventListener('error', () => {
      if (this.ws === ws) this.handlers.onStatus?.('closed', 'socket error');
    });
  }

  private send(method: string, params: string[]): void {
    if (this.ws?.readyState !== OPEN) return; // re-sent from `open`
    this.ws.send(JSON.stringify({ method, params, id: this.nextId++ }));
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Exposed for tests: routes one raw frame to the right handler. */
  dispatch(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    const obj = m as Record<string, unknown>;
    if (Array.isArray(obj.subscription_outcomes)) {
      for (const o of obj.subscription_outcomes as Array<Record<string, unknown>>) {
        if (o.status === 'rejected') {
          const s = String(o.requested);
          this.streams.delete(s);
          this.handlers.onRejected?.(s, String(o.reason ?? 'rejected'));
        }
      }
      return;
    }
    if (typeof obj.channel !== 'string') return;
    const ch = parseChannel(obj.channel);
    if (!ch) return;
    if (ch.kind === 'depth') this.handlers.onDepth?.(ch.symbol, m as DepthMsg);
    else if (ch.kind === 'trades') this.handlers.onTrade?.(ch.symbol, m as TradeMsg);
    else this.handlers.onTicker?.(ch.symbol, m as TickerMsg);
  }
}
