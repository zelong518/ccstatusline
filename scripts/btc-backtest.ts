/**
 * Replay the Crypto Advice ask over history and settle it against the tape.
 *
 * The widget's own ledger only holds the handful of calls a live session made,
 * which cannot answer "what if it traded every 30 minutes". So this rebuilds
 * the snapshot the widget would have sent at each half hour - from that
 * moment's candles only - asks the same model through the same prompt, and
 * marks the result to the next half-hourly close.
 *
 * News search is off: a model searching today would read reports written after
 * the moment it is being asked about, and score itself on the future. What this
 * measures is therefore the chart-only ask, not the one the widget ships.
 *
 *   bun run scripts/btc-backtest.ts [--bars 96] [--symbol BTCUSDT] [--concurrency 6]
 */
import type {
    Bar,
    BtcMarketData,
    FearGreedIndex
} from '../src/utils/btc';
import {
    barCloses,
    rsi,
    sma
} from '../src/utils/btc';
import {
    DEFAULT_ADVICE_MODEL,
    askMarketSnapshotAsync,
    type BtcVerdict
} from '../src/utils/btc-advice';

const HALF_HOUR_MS = 30 * 60_000;
const FEE_RATE = 0.001;   // Binance spot taker, one side

interface Args { bars: number; symbol: string; concurrency: number; model: string; stability: number }

function parseArgs(): Args {
    const read = (flag: string, fallback: string): string => {
        const index = process.argv.indexOf(flag);
        return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
    };
    return {
        bars: Number(read('--bars', '96')),
        symbol: read('--symbol', 'BTCUSDT').toUpperCase(),
        concurrency: Number(read('--concurrency', '6')),
        model: read('--model', DEFAULT_ADVICE_MODEL),
        // Ask the same snapshot N times instead of replaying: how much of the
        // verdict changing from one half hour to the next is the market, and
        // how much is just the model answering twice?
        stability: Number(read('--stability', '0'))
    };
}

async function getJson(url: string): Promise<unknown> {
    const response = await fetch(url, { headers: { 'User-Agent': 'ccstatusline-backtest' } });
    if (!response.ok) {
        throw new Error(`${url} -> ${response.status}`);
    }
    return response.json();
}

function toBars(rows: unknown): Bar[] {
    return (rows as unknown[][]).map(row => ({
        t: Number(row[0]),
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4])
    }));
}

/** Fear & Greed is published daily; key it by UTC day so a replay can look up
 *  the value that was on screen that day rather than today's. */
async function fetchFearGreedByDay(): Promise<Map<string, FearGreedIndex>> {
    const byDay = new Map<string, FearGreedIndex>();
    try {
        const payload = await getJson('https://api.alternative.me/fng/?limit=90') as { data?: { value: string; value_classification: string; timestamp: string }[] };
        for (const row of payload.data ?? []) {
            const day = new Date(Number(row.timestamp) * 1000).toISOString().slice(0, 10);
            byDay.set(day, { value: Number(row.value), label: row.value_classification });
        }
    } catch {
        // The ask treats a missing index as simply absent
    }
    return byDay;
}

/** Indexed read that says which index was missing instead of asserting. */
function at<T>(items: readonly T[], index: number): T {
    const value = items[index];
    if (value === undefined) {
        throw new Error(`no element at index ${index} (length ${items.length})`);
    }
    return value;
}

function percentChange(current: number, previous: number | undefined): number | undefined {
    return previous === undefined || previous === 0 ? undefined : (current - previous) / previous * 100;
}

/**
 * The quote the widget would have built at `now`, using nothing later than it:
 * completed daily candles from before today, plus today's candle as far as it
 * had formed by that moment.
 */
function snapshotAt(
    symbol: string,
    halfHours: Bar[],
    index: number,
    completedDays: Bar[],
    fearGreed: Map<string, FearGreedIndex>
): BtcMarketData {
    const bar = at(halfHours, index);
    const now = bar.t + HALF_HOUR_MS;
    const price = bar.c;
    const day = new Date(now - 1).toISOString().slice(0, 10);

    const todayStart = Date.parse(`${day}T00:00:00Z`);
    const todayHalfHours = halfHours.slice(0, index + 1).filter(candle => candle.t >= todayStart);
    const dailyBars = completedDays.filter(candle => candle.t < todayStart);
    if (todayHalfHours.length > 0) {
        dailyBars.push({
            t: todayStart,
            o: at(todayHalfHours, 0).o,
            h: Math.max(...todayHalfHours.map(candle => candle.h)),
            l: Math.min(...todayHalfHours.map(candle => candle.l)),
            c: price
        });
    }

    const window24h = halfHours.slice(Math.max(0, index - 47), index + 1);
    const todaysFearGreed = fearGreed.get(day);
    const dailyCloses = barCloses(dailyBars);
    const closeBack = (count: number): number | undefined => dailyCloses[dailyCloses.length - 1 - count];
    const high60d = Math.max(...dailyCloses);
    const low60d = Math.min(...dailyCloses);

    return {
        symbol,
        source: 'binance',
        fetchedAt: now,
        price,
        change1h: percentChange(price, halfHours[index - 2]?.c),
        change24h: percentChange(price, halfHours[index - 48]?.c) ?? 0,
        change7d: percentChange(price, closeBack(7)),
        change30d: percentChange(price, closeBack(30)),
        high24h: Math.max(...window24h.map(candle => candle.h)),
        low24h: Math.min(...window24h.map(candle => candle.l)),
        ma7: sma(dailyCloses, 7),
        ma30: sma(dailyCloses, 30),
        rsi14: rsi(dailyCloses, 14),
        rangePosition60d: high60d > low60d ? (price - low60d) / (high60d - low60d) * 100 : undefined,
        hourlyBars: halfHours.slice(Math.max(0, index - 47), index + 1),
        dailyBars: dailyBars.slice(-30),
        ...(todaysFearGreed ? { fearGreed: todaysFearGreed } : {})
    };
}

interface Call { at: number; price: number; next: number; verdict: BtcVerdict; confidence: number; reason: string }

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(at(items, index), index);
        }
    }));
    return results;
}

/** Position the verdict puts you in, given where you already were. */
function positionFor(verdict: BtcVerdict, previous: number, rule: 'spot' | 'perp' | 'flat-on-hold'): number {
    if (verdict === 'BUY') {
        return 1;
    }
    if (verdict === 'SELL') {
        return rule === 'perp' ? -1 : 0;
    }
    return rule === 'flat-on-hold' ? 0 : previous;   // HOLD keeps what you have
}

function simulate(calls: Call[], rule: 'spot' | 'perp' | 'flat-on-hold'): { gross: number; net: number; turnover: number; trades: number } {
    let equity = 1;
    let grossEquity = 1;
    let position = 0;
    let turnover = 0;
    let trades = 0;

    for (const call of calls) {
        const next = positionFor(call.verdict, position, rule);
        const change = Math.abs(next - position);
        if (change > 0) {
            trades++;
            turnover += change;
            equity *= 1 - change * FEE_RATE;
        }
        position = next;
        const move = (call.next - call.price) / call.price;
        equity *= 1 + position * move;
        grossEquity *= 1 + position * move;
    }

    return { gross: (grossEquity - 1) * 100, net: (equity - 1) * 100, turnover, trades };
}

async function main(): Promise<void> {
    const args = parseArgs();
    const [halfHourRows, dailyRows, fearGreed] = await Promise.all([
        getJson(`https://api.binance.com/api/v3/klines?symbol=${args.symbol}&interval=30m&limit=1000`),
        getJson(`https://api.binance.com/api/v3/klines?symbol=${args.symbol}&interval=1d&limit=200`),
        fetchFearGreedByDay()
    ]);

    const halfHours = toBars(halfHourRows);
    const completedDays = toBars(dailyRows).slice(0, -1);   // drop the in-progress day
    // The last bar has no "next close" to settle against, so decisions stop one short
    const lastDecision = halfHours.length - 2;
    const indices = Array.from({ length: args.bars }, (unused, offset) => lastDecision - args.bars + 1 + offset);

    const from = new Date(at(halfHours, at(indices, 0)).t + HALF_HOUR_MS).toISOString();
    const to = new Date(at(halfHours, lastDecision).t + HALF_HOUR_MS).toISOString();
    console.log(`${args.symbol}: replaying ${args.bars} half-hourly decisions, ${from} -> ${to}`);
    console.log(`model ${args.model}, news off (a search today would see the future), fee ${FEE_RATE * 100}% per side\n`);

    if (args.stability > 0) {
        const market = snapshotAt(args.symbol, halfHours, lastDecision, completedDays, fearGreed);
        const answers = await mapWithConcurrency(Array.from({ length: args.stability }, (unused, index) => index), args.concurrency,
            async () => askMarketSnapshotAsync(market, args.model, 'en', false));
        const tally = { BUY: 0, HOLD: 0, SELL: 0 };
        for (const answer of answers) {
            tally[answer.verdict]++;
        }
        console.log(`same snapshot (${new Date(market.fetchedAt).toISOString()}), asked ${args.stability} times:`);
        console.log(`  BUY ${tally.BUY} · HOLD ${tally.HOLD} · SELL ${tally.SELL}`);
        console.log(`  confidence ${answers.map(answer => answer.confidence).join(', ')}`);
        return;
    }

    let done = 0;
    const calls = await mapWithConcurrency<number, Call | null>(indices, args.concurrency, async (index): Promise<Call | null> => {
        const market = snapshotAt(args.symbol, halfHours, index, completedDays, fearGreed);
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const answer = await askMarketSnapshotAsync(market, args.model, 'en', false);
                process.stderr.write(`\r  asked ${++done}/${args.bars}`);
                return {
                    at: market.fetchedAt,
                    price: market.price,
                    next: at(halfHours, index + 1).c,
                    verdict: answer.verdict,
                    confidence: answer.confidence,
                    reason: answer.reason
                };
            } catch (error) {
                if (attempt === 2) {
                    process.stderr.write(`\n  ${new Date(market.fetchedAt).toISOString()} failed: ${String(error).slice(0, 120)}\n`);
                    return null;
                }
                await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
            }
        }
        return null;
    });

    const answered = calls.filter((call): call is Call => call !== null);
    process.stderr.write('\n\n');

    const counts = { BUY: 0, HOLD: 0, SELL: 0 };
    for (const call of answered) {
        counts[call.verdict]++;
    }

    const first = at(answered, 0);
    const last = at(answered, answered.length - 1);
    const buyAndHold = (last.next - first.price) / first.price * 100;

    console.log(`answered ${answered.length}/${args.bars}   BUY ${counts.BUY} · HOLD ${counts.HOLD} · SELL ${counts.SELL}`);
    console.log(`price ${first.price.toFixed(2)} -> ${last.next.toFixed(2)}   buy & hold ${buyAndHold >= 0 ? '+' : ''}${buyAndHold.toFixed(2)}%\n`);

    const rules: [string, 'spot' | 'perp' | 'flat-on-hold'][] = [
        ['spot (BUY=long, SELL=cash, HOLD=keep)', 'spot'],
        ['perp (BUY=long, SELL=short, HOLD=keep)', 'perp'],
        ['flat on HOLD (only act while it says BUY/SELL)', 'flat-on-hold']
    ];
    console.log('rule                                            gross     net    trades  turnover');
    for (const [label, rule] of rules) {
        const result = simulate(answered, rule);
        console.log(`${label.padEnd(46)} ${`${result.gross >= 0 ? '+' : ''}${result.gross.toFixed(2)}%`.padStart(7)} ${`${result.net >= 0 ? '+' : ''}${result.net.toFixed(2)}%`.padStart(7)} ${String(result.trades).padStart(7)} ${result.turnover.toFixed(1).padStart(9)}`);
    }

    // Per-call detail, so the numbers above can be checked by hand
    console.log('\ntime (UTC)        verdict  conf   price      next     move    reason');
    for (const call of answered) {
        const move = (call.next - call.price) / call.price * 100;
        console.log(`${new Date(call.at).toISOString().slice(5, 16)}   ${call.verdict.padEnd(6)} ${String(call.confidence).padStart(4)}  ${call.price.toFixed(0)}  ${call.next.toFixed(0)}  ${`${move >= 0 ? '+' : ''}${move.toFixed(2)}%`.padStart(7)}   ${call.reason.slice(0, 60)}`);
    }
}

void main();
