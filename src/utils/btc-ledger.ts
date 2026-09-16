import { spawn } from 'child_process';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync
} from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import { httpGetJson } from './btc';
import type { BtcVerdict } from './btc-advice';
import { getConfigPath } from './config';

// Was the advice any good? A verdict that is never scored is just vibes, so
// every answer is written to a ledger, and once its horizon has passed the
// price that actually happened is fetched and the call is marked hit or miss.
//
// The ledger lives next to settings.json, not in ~/.cache: it is the one piece
// of state here that would hurt to lose.
const LEDGER_VERSION = 1;
const MAX_ENTRIES = 3000;
const DEFAULT_THRESHOLD_PERCENT = 2;      // a move smaller than this is "flat"
const DEFAULT_SAMPLE_HOURS = 6;           // stats keep one call per this window
const MIN_SAMPLE_FOR_RATE = 5;
const MAX_KLINES_PER_REQUEST = 1000;

export interface Horizon {
    id: string;
    hours: number;
    label: string;
}

// Mid-to-long-term horizons: a swing call is not settled by the next hour
export const HORIZONS: readonly Horizon[] = [
    { id: '24h', hours: 24, label: '1 day' },
    { id: '72h', hours: 72, label: '3 days' },
    { id: '7d', hours: 168, label: '7 days' }
];

export const DEFAULT_HORIZON_ID = '72h';
const FALLBACK_HORIZON: Horizon = { id: DEFAULT_HORIZON_ID, hours: 72, label: '3 days' };

export function getHorizon(id: string | undefined): Horizon {
    return HORIZONS.find(horizon => horizon.id === id)
        ?? HORIZONS.find(horizon => horizon.id === DEFAULT_HORIZON_ID)
        ?? FALLBACK_HORIZON;
}

const OutcomeSchema = z.object({
    at: z.number(),
    price: z.number(),
    changePercent: z.number(),
    hit: z.boolean()
});

const PredictionSchema = z.object({
    askedAt: z.number(),
    verdict: z.enum(['BUY', 'HOLD', 'SELL']),
    confidence: z.number(),
    price: z.number(),
    model: z.string(),
    newsUsed: z.boolean().optional(),
    catalyst: z.string().optional(),
    outcomes: z.record(z.string(), OutcomeSchema).default({})
});

const LedgerSchema = z.object({
    version: z.number(),
    symbol: z.string(),
    thresholdPercent: z.number(),
    entries: z.array(PredictionSchema)
});

export type PredictionOutcome = z.infer<typeof OutcomeSchema>;
export type Prediction = z.infer<typeof PredictionSchema>;
export type Ledger = z.infer<typeof LedgerSchema>;

export const BTC_SCORE_FLAG = '--internal-btc-score';
const SCORE_LOCK_STALE_MS = 120_000;

function getScoreLockPath(symbol: string): string {
    return path.join(os.homedir(), '.cache', 'ccstatusline', `btc-score-${symbol}.lock`);
}

/**
 * Settle the due calls in the background. Scoring is a couple of HTTP requests
 * and happens at most once per due horizon, so it rides the same detached
 * re-entry the ask does rather than the render path.
 */
export function scheduleScoring(symbol: string): void {
    const scriptPath = process.argv[1];
    if (!scriptPath) {
        return;
    }

    const lockPath = getScoreLockPath(symbol);
    try {
        mkdirSync(path.dirname(lockPath), { recursive: true });
        if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs < SCORE_LOCK_STALE_MS) {
            return;
        }
        rmSync(lockPath, { force: true });
        closeSync(openSync(lockPath, 'wx'));
    } catch {
        return;
    }

    try {
        const child = spawn(process.execPath, [scriptPath, BTC_SCORE_FLAG, symbol, lockPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();
    } catch {
        rmSync(lockPath, { force: true });
    }
}

export function releaseScoreLock(lockPath: string): void {
    try {
        rmSync(lockPath, { force: true });
    } catch {
        // Ignore lock file errors
    }
}

export function getLedgerPath(symbol: string): string {
    return path.join(path.dirname(getConfigPath()), `btc-ledger-${symbol}.json`);
}

function emptyLedger(symbol: string): Ledger {
    return { version: LEDGER_VERSION, symbol, thresholdPercent: DEFAULT_THRESHOLD_PERCENT, entries: [] };
}

export function readLedger(symbol: string): Ledger {
    try {
        const parsed = LedgerSchema.safeParse(JSON.parse(readFileSync(getLedgerPath(symbol), 'utf8')));
        return parsed.success ? parsed.data : emptyLedger(symbol);
    } catch {
        return emptyLedger(symbol);
    }
}

export function writeLedger(ledger: Ledger): void {
    const target = getLedgerPath(ledger.symbol);
    try {
        mkdirSync(path.dirname(target), { recursive: true });
        // Written via rename: a half-written ledger would lose the history
        const temporary = `${target}.tmp`;
        writeFileSync(temporary, JSON.stringify(ledger));
        renameSync(temporary, target);
    } catch {
        // Best-effort: a lost record is better than a broken status line
    }
}

/** Record one answer. Same-second duplicates are ignored. */
export function appendPrediction(symbol: string, prediction: Omit<Prediction, 'outcomes'>): void {
    const ledger = readLedger(symbol);
    if (ledger.entries.some(entry => entry.askedAt === prediction.askedAt)) {
        return;
    }

    ledger.entries.push({ ...prediction, outcomes: {} });
    ledger.entries.sort((left, right) => left.askedAt - right.askedAt);
    if (ledger.entries.length > MAX_ENTRIES) {
        ledger.entries = ledger.entries.slice(-MAX_ENTRIES);
    }
    writeLedger(ledger);
}

function deadlineOf(entry: Prediction, horizon: Horizon): number {
    return entry.askedAt + horizon.hours * 3_600_000;
}

/** True when some call's horizon has passed without the price being checked. */
export function hasDueScoring(ledger: Ledger, now = Date.now()): boolean {
    return ledger.entries.some(entry => HORIZONS.some(horizon => !entry.outcomes[horizon.id] && deadlineOf(entry, horizon) <= now));
}

export function isHit(verdict: BtcVerdict, changePercent: number, thresholdPercent: number): boolean {
    if (verdict === 'BUY') {
        return changePercent >= thresholdPercent;
    }
    if (verdict === 'SELL') {
        return changePercent <= -thresholdPercent;
    }
    return Math.abs(changePercent) < thresholdPercent;
}

function floorToHour(timestamp: number): number {
    return Math.floor(timestamp / 3_600_000) * 3_600_000;
}

/**
 * Hourly closes from `fromMs` to now, keyed by the hour they closed in. One
 * request covers ~41 days; a longer gap is walked in a few pages.
 */
async function fetchHourlyCloses(symbol: string, fromMs: number): Promise<Map<number, number>> {
    const closes = new Map<number, number>();
    let cursor = floorToHour(fromMs);

    for (let page = 0; page < 4 && cursor < Date.now(); page++) {
        const payload = await httpGetJson('api.binance.com', `/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${cursor}&limit=${MAX_KLINES_PER_REQUEST}`);
        if (!Array.isArray(payload) || payload.length === 0) {
            break;
        }

        for (const row of payload) {
            if (!Array.isArray(row)) {
                continue;
            }
            const openTime = Number(row[0]);
            const close = Number(row[4]);
            if (Number.isFinite(openTime) && Number.isFinite(close)) {
                closes.set(openTime, close);
            }
        }

        const last: unknown = payload[payload.length - 1];
        const lastOpen = Array.isArray(last) ? Number(last[0]) : NaN;
        if (!Number.isFinite(lastOpen)) {
            break;
        }
        cursor = lastOpen + 3_600_000;
    }

    return closes;
}

/**
 * Settle every call whose horizon has passed, against the hourly close at that
 * moment. Returns how many were scored.
 */
export async function scoreLedger(symbol: string, now = Date.now()): Promise<number> {
    const ledger = readLedger(symbol);
    const due: { entry: Prediction; horizon: Horizon; deadline: number }[] = [];

    for (const entry of ledger.entries) {
        for (const horizon of HORIZONS) {
            const deadline = deadlineOf(entry, horizon);
            if (!entry.outcomes[horizon.id] && deadline <= now) {
                due.push({ entry, horizon, deadline });
            }
        }
    }

    if (due.length === 0) {
        return 0;
    }

    const earliest = Math.min(...due.map(item => item.deadline));
    const closes = await fetchHourlyCloses(symbol, earliest);
    if (closes.size === 0) {
        return 0;   // venue unreachable; try again next time
    }

    let scored = 0;
    for (const { entry, horizon, deadline } of due) {
        const close = closes.get(floorToHour(deadline));
        if (close === undefined || entry.price <= 0) {
            continue;
        }

        const changePercent = (close - entry.price) / entry.price * 100;
        entry.outcomes[horizon.id] = {
            at: deadline,
            price: close,
            changePercent,
            hit: isHit(entry.verdict, changePercent, ledger.thresholdPercent)
        };
        scored++;
    }

    if (scored > 0) {
        writeLedger(ledger);
    }
    return scored;
}

// --- stats ---

export interface VerdictStats {
    n: number;
    hits: number;
}

export interface LedgerSummary {
    horizon: Horizon;
    thresholdPercent: number;
    /** Scored calls in the sample (at most one per sampling window). */
    n: number;
    hits: number;
    rate: number | null;
    /** Hit rate of the best single verdict repeated every time, on the same
     *  sample - the bar a real signal has to clear. */
    baselineRate: number | null;
    baselineVerdict: BtcVerdict | null;
    byVerdict: Record<BtcVerdict, VerdictStats>;
    /** Calls recorded in total, before sampling and including unscored ones. */
    recorded: number;
    pending: number;
    averageChangePercent: number | null;
    enoughData: boolean;
}

const VERDICTS: readonly BtcVerdict[] = ['BUY', 'HOLD', 'SELL'];

/**
 * One call per sampling window. The status line asks every half hour, and
 * forty-eight near-identical calls a day would drown out the handful of
 * genuinely different ones - and flatter the hit rate whenever the market
 * spends a day doing nothing.
 */
export function sampleEntries(entries: readonly Prediction[], sampleHours: number): Prediction[] {
    const period = Math.max(1, sampleHours) * 3_600_000;
    const seen = new Set<number>();
    const sampled: Prediction[] = [];

    for (const entry of [...entries].sort((left, right) => left.askedAt - right.askedAt)) {
        const bucket = Math.floor(entry.askedAt / period);
        if (!seen.has(bucket)) {
            seen.add(bucket);
            sampled.push(entry);
        }
    }

    return sampled;
}

export function summarize(
    ledger: Ledger,
    options: { horizonId?: string; sampleHours?: number } = {}
): LedgerSummary {
    const horizon = getHorizon(options.horizonId);
    const sampled = sampleEntries(ledger.entries, options.sampleHours ?? DEFAULT_SAMPLE_HOURS);
    const scored = sampled.filter(entry => entry.outcomes[horizon.id] !== undefined);

    const byVerdict = Object.fromEntries(VERDICTS.map(verdict => [verdict, { n: 0, hits: 0 }])) as Record<BtcVerdict, VerdictStats>;
    let hits = 0;
    let changeTotal = 0;

    for (const entry of scored) {
        const outcome = entry.outcomes[horizon.id];
        if (!outcome) {
            continue;
        }
        const bucket = byVerdict[entry.verdict];
        bucket.n++;
        changeTotal += outcome.changePercent;
        if (outcome.hit) {
            hits++;
            bucket.hits++;
        }
    }

    // What a fixed opinion would have scored on exactly the same days
    let baselineRate: number | null = null;
    let baselineVerdict: BtcVerdict | null = null;
    for (const verdict of VERDICTS) {
        const constantHits = scored.filter((entry) => {
            const outcome = entry.outcomes[horizon.id];
            return outcome !== undefined && isHit(verdict, outcome.changePercent, ledger.thresholdPercent);
        }).length;
        const rate = scored.length > 0 ? constantHits / scored.length * 100 : null;
        if (rate !== null && (baselineRate === null || rate > baselineRate)) {
            baselineRate = rate;
            baselineVerdict = verdict;
        }
    }

    return {
        horizon,
        thresholdPercent: ledger.thresholdPercent,
        n: scored.length,
        hits,
        rate: scored.length > 0 ? hits / scored.length * 100 : null,
        baselineRate,
        baselineVerdict,
        byVerdict,
        recorded: ledger.entries.length,
        pending: sampled.length - scored.length,
        averageChangePercent: scored.length > 0 ? changeTotal / scored.length : null,
        enoughData: scored.length >= MIN_SAMPLE_FOR_RATE
    };
}

/** `ccstatusline --btc-score [SYMBOL]`: the whole record, horizon by horizon. */
export function formatScoreForCli(symbol: string, sampleHours = DEFAULT_SAMPLE_HOURS): string {
    const ledger = readLedger(symbol);
    if (ledger.entries.length === 0) {
        return `${symbol}: no calls recorded yet - the ledger fills as the advice widget asks.`;
    }

    const percent = (value: number | null): string => (value === null ? '   -' : `${value.toFixed(0).padStart(3)}%`);
    const lines = [
        `${symbol}  prediction record`,
        `  ${ledger.entries.length} calls recorded, scored when a move of ${ledger.thresholdPercent}% decides them,`,
        `  counting at most one call per ${sampleHours}h so a busy day cannot outvote a quiet week.`,
        '',
        '  horizon   calls   hit rate   always-same-answer   edge',
        '  -------   -----   --------   ------------------   ----'
    ];

    for (const horizon of HORIZONS) {
        const summary = summarize(ledger, { horizonId: horizon.id, sampleHours });
        const edge = summary.rate !== null && summary.baselineRate !== null
            ? `${(summary.rate - summary.baselineRate >= 0 ? '+' : '')}${(summary.rate - summary.baselineRate).toFixed(0)}pt`
            : '   -';
        const baseline = summary.baselineVerdict ? `${percent(summary.baselineRate)} (${summary.baselineVerdict})` : '     -';
        lines.push(`  ${horizon.id.padEnd(9)} ${String(summary.n).padStart(5)}   ${percent(summary.rate)}      ${baseline.padEnd(18)}   ${edge}`);
    }

    const main = summarize(ledger, { sampleHours });
    lines.push('', `  by verdict at ${main.horizon.id}:`);
    for (const [verdict, stats] of Object.entries(main.byVerdict)) {
        lines.push(`    ${verdict.padEnd(5)} ${stats.hits}/${stats.n}`);
    }
    if (!main.enoughData) {
        lines.push('', '  Too few scored calls to read anything into the rate yet.');
    }

    const recent = [...ledger.entries].sort((left, right) => right.askedAt - left.askedAt).slice(0, 10);
    lines.push('', '  most recent calls:');
    for (const entry of recent) {
        const outcome = entry.outcomes[main.horizon.id];
        const result = outcome
            ? `${outcome.hit ? 'hit ' : 'miss'} ${outcome.changePercent >= 0 ? '+' : ''}${outcome.changePercent.toFixed(1)}%`
            : 'pending';
        lines.push(`    ${new Date(entry.askedAt).toLocaleString()}  ${entry.verdict.padEnd(4)} ${String(entry.confidence).padStart(3)}  @${entry.price.toFixed(0).padStart(8)}  ${result}`);
    }

    lines.push('', '  Not investment advice.');
    return lines.join('\n');
}
