import {
    describe,
    expect,
    it
} from 'vitest';

import {
    formatAge,
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

describe('formatAge', () => {
    it('steps through seconds, minutes, hours and days', () => {
        expect(formatAge(40_000)).toBe('40s');
        expect(formatAge(12 * 60_000)).toBe('12m');
        expect(formatAge(3 * 3_600_000)).toBe('3h');
        expect(formatAge(2 * 86_400_000)).toBe('2d');
    });
});
