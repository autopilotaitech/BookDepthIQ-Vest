import { describe, expect, it } from 'vitest';
import { ORDER_LOG_MAX, OrderLog } from '../src/panel/orderlog.js';

describe('order log', () => {
  it('keeps the last entries, oldest first, with a header', () => {
    const l = new OrderLog();
    l.add('click', 'PAPER BUY MARKET · GC-PERP', Date.UTC(2026, 9, 13, 14, 0, 0));
    l.add('blocked', 'needs a second click', Date.UTC(2026, 9, 13, 14, 0, 1));
    expect(l.text(['hdr'])).toBe('hdr\n14:00:00.000Z → PAPER BUY MARKET · GC-PERP\n14:00:01.000Z ⊘ needs a second click');
    for (let i = 0; i < ORDER_LOG_MAX + 5; i++) l.add('ok', String(i));
    expect(l.entries.length).toBe(ORDER_LOG_MAX);
    expect(l.entries.at(-1)!.text).toBe(String(ORDER_LOG_MAX + 4));
  });
});
