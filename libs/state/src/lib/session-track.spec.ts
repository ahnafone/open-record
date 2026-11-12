import {
  SESSION_MAX_ENTRIES,
  SESSION_MAX_ORDER_BYTES,
  type SessionTrack,
} from '@open-record/models';
import { fitSessionOrder, fromSessionTrack } from './session-track';

function entry(i: number, title = 'T'): SessionTrack {
  return { entryId: `e${i}`, id: `catalog:${i}`, providerId: 'catalog', title, artist: 'A' };
}

describe('fitSessionOrder', () => {
  it('keeps everything when order + stack fit the caps', () => {
    const order = [entry(0), entry(1), entry(2)];
    expect(fitSessionOrder(order, [entry(9)], 1)).toEqual({ start: 0, end: 3, cursor: 1 });
  });

  it('drops the autofill tail first so order + stack fits the entry cap', () => {
    const order = Array.from({ length: 1200 }, (_, i) => entry(i));
    const stack = Array.from({ length: 100 }, (_, i) => entry(5000 + i));
    const fit = fitSessionOrder(order, stack, 3);
    expect(fit).toEqual({ start: 0, end: SESSION_MAX_ENTRIES - stack.length, cursor: 3 });
  });

  it('drops the autofill tail first so order + stack fits the byte cap', () => {
    const order = Array.from({ length: 600 }, (_, i) => entry(i, 'x'.repeat(1000)));
    const fit = fitSessionOrder(order, [], 0);
    const bytes = new TextEncoder().encode(JSON.stringify(order.slice(fit.start, fit.end)))
      .length;
    expect(bytes).toBeLessThanOrEqual(SESSION_MAX_ORDER_BYTES);
    expect(fit.end).toBeLessThan(order.length);
    expect(fit.end).toBeGreaterThan(fit.cursor);
  });

  it('drops the oldest history only when the current entry and the stack alone still overflow', () => {
    const order = Array.from({ length: 1000 }, (_, i) => entry(i));
    const stack = Array.from({ length: 500 }, (_, i) => entry(9000 + i));
    const fit = fitSessionOrder(order, stack, 900);
    expect(fit.end - fit.start + stack.length).toBeLessThanOrEqual(SESSION_MAX_ENTRIES);
    expect(fit.end).toBe(901);
    expect(order[fit.start + fit.cursor]?.entryId).toBe('e900');
  });
});

describe('fromSessionTrack', () => {
  it('drops remote art and page links that are not http(s) or bundled catalog art', () => {
    const base: SessionTrack = {
      entryId: 'e1',
      id: 'remote:abc',
      providerId: 'remote',
      title: 'T',
      artist: 'A',
    };
    const hostile = fromSessionTrack({
      ...base,
      artUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
      source: { site: 'youtube', url: 'javascript:alert(1)' },
    });
    expect(hostile.artUrl).toBeUndefined();
    expect(hostile.source).toBeUndefined();

    const ok = fromSessionTrack({
      ...base,
      artUrl: 'https://i.example/abc.jpg',
      source: { site: 'youtube', url: 'https://youtu.be/abc', id: 'abc' },
    });
    expect(ok.artUrl).toBe('https://i.example/abc.jpg');
    expect(ok.source).toEqual({ site: 'youtube', url: 'https://youtu.be/abc', id: 'abc' });
  });
});
