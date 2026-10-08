import { describe, expect, it, vi } from 'vitest';
import { LiveSession } from '../src/live/session.js';
import { PRIVATE_WS_PROTOCOL, PRIVATE_WS_URL, VestPrivateSocket, isChatter, type PrivateSocketLike } from '../src/vest/privateWs.js';

class FakeSocket implements PrivateSocketLike {
  readyState = 0;
  sent: string[] = [];
  private fns: Record<string, ((ev: { data: unknown }) => void)[]> = {};
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  addEventListener(t: string, fn: (ev: { data: unknown }) => void) {
    (this.fns[t] ||= []).push(fn);
  }
  emit(t: string, data?: unknown) {
    if (t === 'open') this.readyState = 1;
    for (const f of this.fns[t] ?? []) f({ data });
  }
}

describe('Vest private socket (push trigger)', () => {
  it('connects to /ws/private with ["vest.v1", token], as Vest\'s own app does', () => {
    const made: FakeSocket[] = [];
    const s = new VestPrivateSocket(() => 'TOKEN', { onAccountEvent: () => {}, onStatus: () => {} }, (u, p) => {
      const f = new FakeSocket(u, p);
      made.push(f);
      return f;
    });
    s.start();
    expect(made).toHaveLength(1);
    expect(made[0]!.url).toBe('wss://ws.hz.vestmarkets.com/ws/private');
    expect(PRIVATE_WS_URL).toBe('wss://ws.hz.vestmarkets.com/ws/private');
    expect(made[0]!.protocols).toEqual([PRIVATE_WS_PROTOCOL, 'TOKEN']);
    expect(PRIVATE_WS_PROTOCOL).toBe('vest.v1');
    s.stop();
  });

  it('an account frame triggers a read; pongs and acks do not', () => {
    let events = 0;
    let open = false;
    let sock!: FakeSocket;
    const s = new VestPrivateSocket(() => 'T', { onAccountEvent: () => events++, onStatus: (o) => (open = o) }, (u, p) => (sock = new FakeSocket(u, p)));
    s.start();
    sock.emit('open');
    expect(open).toBe(true);
    expect(events).toBe(1); // catch-up read on connect
    sock.emit('message', JSON.stringify({ account_id: 'A1', orders: [{ event_type: 'ORDER_EVENT_TYPE_PLACED' }] }));
    expect(events).toBe(2);
    sock.emit('message', JSON.stringify({ id: 3, result: 'PONG' }));
    sock.emit('message', JSON.stringify({ subscription_outcomes: [] }));
    expect(events).toBe(2);
    s.stop();
    expect(open).toBe(false);
  });

  it('chatter filter', () => {
    expect(isChatter('{"id":1,"result":null}')).toBe(true);
    expect(isChatter('{"method":"PONG"}')).toBe(true);
    expect(isChatter('{"account_id":"A","positions":[]}')).toBe(false);
    expect(isChatter('not json')).toBe(false);
  });

  it('no login: does not open a socket (polling covers it)', () => {
    vi.useFakeTimers();
    const factory = vi.fn();
    const s = new VestPrivateSocket(() => null, { onAccountEvent: () => {}, onStatus: () => {} }, factory);
    s.start();
    expect(factory).not.toHaveBeenCalled();
    s.stop();
    vi.useRealTimers();
  });
});

describe('LiveSession with push', () => {
  it('push open → safety-net poll is 5 s; an account event reads at once', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    let sock!: FakeSocket;
    const user = `x.${btoa(JSON.stringify({ userId: 1, exp: 4102444800 }))}.y`;
    const s = new LiveSession({
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '[]' }),
      uuid: () => 'u',
      now: () => Date.now(),
      onChange: () => {},
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
      privateSocket: (u, p) => (sock = new FakeSocket(u, p)),
    });
    s.setUserToken(user);
    s.accounts = [{ id: 'A1', label: 'A1' }];
    s.selectAccount('A1');
    s.canTrade = true;
    s.goLive();
    expect(sock.protocols).toEqual(['vest.v1', user]);
    sock.emit('open');
    expect(s.pushOpen).toBe(true);
    timers.length = 0;
    await s.poll();
    // the tick reschedules at the push cadence
    const t = timers.length;
    sock.emit('message', '{"account_id":"A1","orders":[]}');
    expect(timers.length).toBe(t + 1);
    expect(timers.at(-1)!.ms).toBe(0); // immediate read
    s.stop();
    expect(s.pushOpen).toBe(false);
  });
});
