import {
    describe,
    expect,
    it
} from 'vitest';

import type { Settings } from '../../types/Settings';
import type { Bar } from '../../utils/btc';
import {
    brailleline,
    candleline,
    formatAge,
    formatClock,
    formatPrice,
    formatSignedPercent,
    sparkline,
    trendKeyForChange
} from '../shared/crypto-display';

describe('formatPrice', () => {
    it('groups thousands and drops decimals on large prices', () => {
        expect(formatPrice(75703.51)).toBe('75,704');
    });

    it('keeps precision on small prices', () => {
        expect(formatPrice(3.5)).toBe('3.50');
        expect(formatPrice(0.0000123)).toBe('0.000012');
    });
});

describe('formatSignedPercent', () => {
    it('marks direction with an arrow', () => {
        expect(formatSignedPercent(1.655)).toBe('▲1.66%');
        expect(formatSignedPercent(-1.655)).toBe('▼1.66%');
    });

    it('drops the arrow when the move rounds to flat', () => {
        expect(formatSignedPercent(0.001)).toBe('0.00%');
    });
});

describe('trendKeyForChange', () => {
    it('treats a missing or negligible change as flat', () => {
        expect(trendKeyForChange(undefined)).toBe('flat');
        expect(trendKeyForChange(0.005)).toBe('flat');
    });

    it('maps direction otherwise', () => {
        expect(trendKeyForChange(2)).toBe('up');
        expect(trendKeyForChange(-2)).toBe('down');
    });
});

describe('sparkline', () => {
    it('spans the block range from the series low to its high', () => {
        expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8)).toBe('▁▂▃▄▅▆▇█');
    });

    it('keeps only the last `points` values', () => {
        expect(sparkline([1, 2, 3, 4], 2)).toHaveLength(2);
    });

    it('draws a flat series mid-height instead of dividing by zero', () => {
        expect(sparkline([5, 5, 5], 3)).toBe('▅▅▅');
    });

    it('is empty for an empty series', () => {
        expect(sparkline([], 12)).toBe('');
    });
});

describe('formatClock', () => {
    it('pads to a 24-hour wall clock in local time', () => {
        // Built and read in local time, so the assertion holds in any timezone
        expect(formatClock(new Date(2026, 8, 16, 18, 37).getTime())).toBe('18:37');
        expect(formatClock(new Date(2026, 8, 16, 9, 5).getTime())).toBe('09:05');
    });
});

describe('formatAge', () => {
    it('steps through seconds, minutes, hours and days', () => {
        expect(formatAge(40_000)).toBe('40s');
        expect(formatAge(12 * 60_000)).toBe('12m');
        expect(formatAge(3 * 3_600_000)).toBe('3h');
        expect(formatAge(2 * 86_400_000)).toBe('2d');
    });
});

describe('candleline', () => {
    // colorLevel 0 means colors are off, so the glyphs come back bare
    const plain = { colorLevel: 0 } as unknown as Settings;
    const bar = (o: number, h: number, l: number, c: number): Bar => ({ t: 0, o, h, l, c });

    it('places each close inside the window high-low range', () => {
        expect(candleline([bar(1, 1, 1, 1), bar(1, 2, 1, 2), bar(2, 3, 2, 3)], 3, plain, 'ansi16')).toBe('▁▅█');
    });

    it('keeps only the last `points` candles', () => {
        expect(candleline([bar(1, 1, 1, 1), bar(1, 2, 1, 2), bar(2, 3, 2, 3)], 2, plain, 'ansi16')).toHaveLength(2);
    });

    it('is empty for an empty series', () => {
        expect(candleline([], 12, plain, 'ansi16')).toBe('');
    });
});

describe('brailleline', () => {
    const plain = { colorLevel: 0 } as unknown as Settings;

    it('draws one cell per requested point', () => {
        expect(brailleline([1, 2, 3, 4, 5, 6, 7, 8], 4, plain, 'ansi16')).toHaveLength(4);
    });

    it('puts a rising series at the bottom on the left and the top on the right', () => {
        const drawn = brailleline([1, 2, 3, 4, 5, 6, 7, 8], 4, plain, 'ansi16');
        const first = drawn.charCodeAt(0) - 0x2800;
        const last = drawn.charCodeAt(3) - 0x2800;
        // Low values set the bottom dots (0x40/0x80), high values the top (0x01/0x08)
        expect(first & 0xC0).not.toBe(0);
        expect(last & 0x09).not.toBe(0);
    });

    it('keeps a flat series on one row instead of dividing by zero', () => {
        expect(new Set(brailleline([5, 5, 5, 5], 2, plain, 'ansi16').split(''))).toHaveProperty('size', 1);
    });

    it('is empty for an empty series', () => {
        expect(brailleline([], 8, plain, 'ansi16')).toBe('');
    });
});
