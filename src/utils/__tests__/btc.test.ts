import {
    describe,
    expect,
    it
} from 'vitest';

import {
    getSymbolBase,
    normalizeSymbol,
    rsi,
    sma
} from '../btc';
import { parseAdviceResponse } from '../btc-advice';

describe('normalizeSymbol', () => {
    it('uppercases and strips separators', () => {
        expect(normalizeSymbol('btc-usdt')).toBe('BTCUSDT');
        expect(normalizeSymbol(' eth/usdt ')).toBe('ETHUSDT');
    });

    it('falls back to BTCUSDT when nothing usable is left', () => {
        expect(normalizeSymbol(undefined)).toBe('BTCUSDT');
        expect(normalizeSymbol('---')).toBe('BTCUSDT');
    });
});

describe('getSymbolBase', () => {
    it('splits the base off known quote currencies', () => {
        expect(getSymbolBase('BTCUSDT')).toBe('BTC');
        expect(getSymbolBase('SOLUSDC')).toBe('SOL');
        expect(getSymbolBase('ETHBTC')).toBe('ETH');
    });

    it('returns the symbol unchanged when the quote is unknown', () => {
        expect(getSymbolBase('WEIRD')).toBe('WEIRD');
    });
});

describe('sma', () => {
    it('averages the last `period` values', () => {
        expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    });

    it('is undefined rather than wrong when the series is too short', () => {
        expect(sma([1, 2], 3)).toBeUndefined();
    });
});

describe('rsi', () => {
    it('reports 100 for an unbroken advance', () => {
        const closes = Array.from({ length: 20 }, (unused, index) => 100 + index);
        expect(rsi(closes, 14)).toBe(100);
    });

    it('reports 0 for an unbroken decline', () => {
        const closes = Array.from({ length: 20 }, (unused, index) => 100 - index);
        expect(rsi(closes, 14)).toBe(0);
    });

    it('sits near the middle when gains and losses alternate evenly', () => {
        const closes = Array.from({ length: 20 }, (unused, index) => (index % 2 === 0 ? 100 : 101));
        expect(rsi(closes, 14)).toBeCloseTo(50, 5);
    });

    it('is undefined rather than wrong when the series is too short', () => {
        expect(rsi([1, 2, 3], 14)).toBeUndefined();
    });
});

describe('parseAdviceResponse', () => {
    const answer = JSON.stringify({
        verdict: 'buy',
        confidence: '73',
        reason: 'CPI came in soft',
        catalyst: 'Fed cut odds jumped',
        sources: ['https://coindesk.com/markets/article', 'reuters.com/x/y']
    });

    it('reads the answer out of the --output-format json envelope', () => {
        const parsed = parseAdviceResponse(JSON.stringify({ result: answer }));
        expect(parsed.verdict).toBe('BUY');
        expect(parsed.confidence).toBe(73);
        expect(parsed.reason).toBe('CPI came in soft');
        expect(parsed.catalyst).toBe('Fed cut odds jumped');
    });

    it('reduces sources to bare domains', () => {
        expect(parseAdviceResponse(JSON.stringify({ result: answer })).sources)
            .toEqual(['coindesk.com', 'reuters.com']);
    });

    it('digs the JSON object out of surrounding prose', () => {
        const parsed = parseAdviceResponse(`Here you go:\n{"verdict":"SELL","confidence":40}\nHope that helps.`);
        expect(parsed.verdict).toBe('SELL');
        expect(parsed.confidence).toBe(40);
    });

    it('clamps a confidence outside 0-100', () => {
        expect(parseAdviceResponse('{"verdict":"HOLD","confidence":420}').confidence).toBe(100);
        expect(parseAdviceResponse('{"verdict":"HOLD","confidence":-5}').confidence).toBe(0);
    });

    it('rejects a verdict that is not one of the three', () => {
        expect(() => parseAdviceResponse('{"verdict":"MAYBE"}')).toThrow(/unexpected verdict/);
    });

    it('rejects an answer with no JSON at all', () => {
        expect(() => parseAdviceResponse('I would rather not say.')).toThrow(/no JSON object/);
    });
});
