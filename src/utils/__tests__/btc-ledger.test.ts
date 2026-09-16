import {
    describe,
    expect,
    it
} from 'vitest';

import type {
    Ledger,
    Prediction
} from '../btc-ledger';
import {
    getHorizon,
    isHit,
    sampleEntries,
    summarize
} from '../btc-ledger';

const HOUR = 3_600_000;

function prediction(hoursAgo: number, verdict: Prediction['verdict'], changePercent?: number): Prediction {
    const askedAt = 1_000_000_000_000 - hoursAgo * HOUR;
    return {
        askedAt,
        verdict,
        confidence: 60,
        price: 100,
        model: 'test',
        outcomes: changePercent === undefined
            ? {}
            : {
                '72h': {
                    at: askedAt + 72 * HOUR,
                    price: 100 * (1 + changePercent / 100),
                    changePercent,
                    hit: isHit(verdict, changePercent, 2)
                }
            }
    };
}

function ledgerOf(entries: Prediction[]): Ledger {
    return { version: 1, symbol: 'BTCUSDT', thresholdPercent: 2, entries };
}

describe('isHit', () => {
    it('gives BUY the move it asked for, in the direction it asked for', () => {
        expect(isHit('BUY', 3, 2)).toBe(true);
        expect(isHit('BUY', 1.9, 2)).toBe(false);
        expect(isHit('BUY', -5, 2)).toBe(false);
    });

    it('mirrors that for SELL', () => {
        expect(isHit('SELL', -3, 2)).toBe(true);
        expect(isHit('SELL', -1.9, 2)).toBe(false);
        expect(isHit('SELL', 5, 2)).toBe(false);
    });

    it('scores HOLD on the market staying inside the band', () => {
        expect(isHit('HOLD', 1.9, 2)).toBe(true);
        expect(isHit('HOLD', -1.9, 2)).toBe(true);
        expect(isHit('HOLD', 2, 2)).toBe(false);
    });
});

describe('sampleEntries', () => {
    it('keeps one call per window so a busy day cannot outvote a quiet week', () => {
        const entries = [prediction(30, 'BUY'), prediction(29, 'SELL'), prediction(28, 'HOLD'), prediction(10, 'BUY')];
        const sampled = sampleEntries(entries, 6);
        expect(sampled).toHaveLength(2);
        expect(sampled[0]?.askedAt).toBe(entries[0]?.askedAt);
    });

    it('keeps everything when each call sits in its own window', () => {
        expect(sampleEntries([prediction(30, 'BUY'), prediction(10, 'SELL')], 1)).toHaveLength(2);
    });
});

describe('summarize', () => {
    // Four calls, one per 12h window so none of them is sampled away
    const entries = [
        prediction(96, 'BUY', 5),     // hit
        prediction(84, 'BUY', -1),    // miss
        prediction(72, 'HOLD', 0.5),  // hit
        prediction(60, 'SELL', -4)    // hit
    ];

    it('counts hits against the scored sample', () => {
        const summary = summarize(ledgerOf(entries), { sampleHours: 6 });
        expect(summary.n).toBe(4);
        expect(summary.hits).toBe(3);
        expect(summary.rate).toBeCloseTo(75, 5);
    });

    it('reports the best fixed answer as the bar to clear', () => {
        const summary = summarize(ledgerOf(entries), { sampleHours: 6 });
        // Always BUY would have caught one of four; always HOLD two of four
        expect(summary.baselineVerdict).toBe('HOLD');
        expect(summary.baselineRate).toBeCloseTo(50, 5);
    });

    it('breaks the record down by verdict', () => {
        const summary = summarize(ledgerOf(entries), { sampleHours: 6 });
        expect(summary.byVerdict.BUY).toEqual({ n: 2, hits: 1 });
        expect(summary.byVerdict.SELL).toEqual({ n: 1, hits: 1 });
    });

    it('counts unscored calls as pending rather than as misses', () => {
        const summary = summarize(ledgerOf([...entries, prediction(1, 'BUY')]), { sampleHours: 6 });
        expect(summary.n).toBe(4);
        expect(summary.pending).toBe(1);
    });

    it('refuses to call a rate meaningful on a handful of calls', () => {
        expect(summarize(ledgerOf(entries.slice(0, 2)), { sampleHours: 6 }).enoughData).toBe(false);
    });

    it('has no rate at all when nothing is scored', () => {
        const summary = summarize(ledgerOf([prediction(1, 'BUY')]), { sampleHours: 6 });
        expect(summary.rate).toBeNull();
        expect(summary.baselineRate).toBeNull();
    });
});

describe('getHorizon', () => {
    it('falls back to the three-day horizon', () => {
        expect(getHorizon(undefined).id).toBe('72h');
        expect(getHorizon('nonsense').id).toBe('72h');
        expect(getHorizon('7d').hours).toBe(168);
    });
});
