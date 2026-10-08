import { WS_URL } from './types.js';

// Vest's PRIVATE account socket, used only as a "something changed on the account" signal.
//
// Facts read from Vest's own web app (2026-10-08): it connects to `${WS_URL}/private` with the
// WebSocket subprotocols ["vest.v1", <user access token>], sends no SUBSCRIBE, and receives account
// frames ({account_id, positions, orders, final_balance, …} with ORDER_EVENT_TYPE_* /
// POSITION_EVENT_TYPE_* events). We do NOT decode those frames: any account frame just triggers an
// immediate REST read of positions + orders, whose readers are already verified. So a change in
// Vest's frame format can only make updates slower (back to polling), never wrong.
//
// It never sends anything but PING. The token goes only into the subprotocol of this one socket to
// Vest, and is never logged.

export const PRIVATE_WS_URL = `${WS_URL.replace(/\?.*$/, '')}/private`;
export const PRIVATE_WS_PROTOCOL = 'vest.v1';

export interface PrivateSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', fn: (ev: unknown) => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}
export type PrivateSocketFactory = (url: string, protocols: string[]) => PrivateSocketLike;

const defaultFactory: PrivateSocketFactory = (url, protocols) =>
  new (globalThis as unknown as { WebSocket: new (u: string, p: string[]) => PrivateSocketLike }).WebSocket(url, protocols);

export interface PrivateHandlers {
  /** An account frame arrived: re-read positions and orders now. */
  onAccountEvent(): void;
  onStatus(open: boolean): void;
}

const OPEN = 1;
const PING_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

/** True for frames that are only protocol chatter (pong, subscribe ack), not account changes. */
export function isChatter(text: string): boolean {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return false; // unknown non-JSON: treat as a change; an extra REST read is harmless
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const o = m as Record<string, unknown>;
  if (Array.isArray(o.subscription_outcomes)) return true;
  if (typeof o.method === 'string' && /^(PONG|PING)$/i.test(o.method)) return true;
  if ('id' in o && 'result' in o && Object.keys(o).length <= 3) return true; // request ack / pong
  if (typeof o.data === 'string' && /^pong$/i.test(o.data)) return true;
  return false;
}

export class VestPrivateSocket {
  private ws: PrivateSocketLike | null = null;
  private stopped = true;
  private backoffMs = 1_000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  open = false;

  constructor(
    private readonly token: () => string | null,
    private readonly handlers: PrivateHandlers,
    private readonly factory: PrivateSocketFactory = defaultFactory,
    private readonly url = PRIVATE_WS_URL,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setOpen(false);
  }

  private connect(): void {
    if (this.stopped) return;
    const t = this.token();
    if (!t) return this.retry(); // no login yet: polling covers it; try again later
    let ws: PrivateSocketLike;
    try {
      ws = this.factory(this.url, [PRIVATE_WS_PROTOCOL, t]);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.backoffMs = 1_000;
      this.setOpen(true);
      this.clearPing();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === OPEN) ws.send(JSON.stringify({ method: 'PING', params: [], id: this.nextId++ }));
      }, PING_MS);
      this.handlers.onAccountEvent(); // catch up on anything missed while disconnected
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws === ws && !isChatter(String(ev.data))) this.handlers.onAccountEvent();
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPing();
      this.setOpen(false);
      this.retry();
    });
    ws.addEventListener('error', () => {
      if (this.ws === ws) this.setOpen(false);
    });
  }

  private retry(): void {
    if (this.stopped || this.retryTimer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  private setOpen(v: boolean): void {
    if (this.open === v) return;
    this.open = v;
    this.handlers.onStatus(v);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
