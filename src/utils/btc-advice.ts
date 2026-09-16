import {
    execFileSync,
    spawn
} from 'child_process';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync
} from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import type { WidgetItem } from '../types/Widget';

import type { BtcMarketData } from './btc';
import {
    BTC_ADVICE_WIDGET_TYPE,
    barCloses,
    fetchBtcMarket,
    getWidgetSymbol
} from './btc';

// "Should I buy?", asked of Claude Code itself on a slow timer.
//
// A big crypto move almost always has a story behind it - a CPI print, an FOMC
// decision, an ETF flow, a regulator, a post by someone the market listens to -
// so the ask runs with WebSearch and is told to find that story first, then read
// the technical snapshot in its light. Charts alone would call every crash a dip.
//
// The ask costs a real model call and takes ~30s with search, so it never happens
// on the render path: a stale cache schedules a detached re-entry of this
// executable (the pattern git-review-cache uses) and the widget keeps drawing the
// previous verdict until that child lands a new one.
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const DEFAULT_INTERVAL_MINUTES = 30;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;
const FAILURE_RETRY_SECONDS = 300;   // a failed ask retries sooner than the interval
const REFRESH_LOCK_STALE_MS = 300_000;
const ASK_TIMEOUT_MS = 240_000;   // news search costs several tool turns
const MAX_REASON_LENGTH = 80;
const MAX_CATALYST_LENGTH = 80;
const MAX_SOURCES = 3;
const MAX_SOURCE_LENGTH = 40;

export const BTC_ADVICE_REFRESH_FLAG = '--internal-refresh-btc-advice';
export const DEFAULT_ADVICE_MODEL = 'claude-haiku-4-5-20251001';

export type BtcVerdict = 'BUY' | 'HOLD' | 'SELL';
export type AdviceLanguage = 'zh' | 'en';

const BtcAdviceSchema = z.object({
    symbol: z.string(),
    askedAt: z.number(),
    model: z.string(),
    verdict: z.enum(['BUY', 'HOLD', 'SELL']).optional(),
    confidence: z.number().optional(),
    reason: z.string().optional(),
    catalyst: z.string().optional(),      // the news driver the ask identified
    sources: z.array(z.string()).optional(),
    newsUsed: z.boolean().optional(),
    price: z.number().optional(),
    error: z.string().optional()
});

export type BtcAdvice = z.infer<typeof BtcAdviceSchema>;

const VERDICT_LABELS: Record<AdviceLanguage, Record<BtcVerdict, string>> = {
    zh: { BUY: '买入', HOLD: '观望', SELL: '卖出' },
    en: { BUY: 'BUY', HOLD: 'HOLD', SELL: 'SELL' }
};

export function getVerdictLabel(verdict: BtcVerdict, language: AdviceLanguage): string {
    return VERDICT_LABELS[language][verdict];
}

export function getAdviceLanguage(item: WidgetItem): AdviceLanguage {
    return item.metadata?.lang === 'en' ? 'en' : 'zh';
}

export function getAdviceModel(item: WidgetItem): string {
    const model = item.metadata?.model?.trim();
    return model?.length ? model : DEFAULT_ADVICE_MODEL;
}

export function getAdviceIntervalMinutes(item: WidgetItem): number {
    const raw = Number(item.metadata?.intervalMinutes);
    if (!Number.isFinite(raw)) {
        return DEFAULT_INTERVAL_MINUTES;
    }
    return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(raw)));
}

function getCacheFile(symbol: string): string {
    return path.join(CACHE_DIR, `btc-advice-${symbol}.json`);
}

function getLockFile(symbol: string): string {
    return path.join(CACHE_DIR, `btc-advice-${symbol}.lock`);
}

function ensureCacheDirExists(): void {
    if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true });
    }
}

export function readCachedBtcAdvice(symbol: string): BtcAdvice | null {
    try {
        const parsed = BtcAdviceSchema.safeParse(JSON.parse(readFileSync(getCacheFile(symbol), 'utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function writeCachedBtcAdvice(advice: BtcAdvice): void {
    try {
        ensureCacheDirExists();
        writeFileSync(getCacheFile(advice.symbol), JSON.stringify(advice));
    } catch {
        // Best-effort caching
    }
}

function isAdviceStale(advice: BtcAdvice | null, intervalMinutes: number): boolean {
    if (!advice) {
        return true;
    }
    const ageSeconds = (Date.now() - advice.askedAt) / 1000;
    return ageSeconds >= (advice.error ? FAILURE_RETRY_SECONDS : intervalMinutes * 60);
}

/** Claim the refresh slot, clearing a lock left behind by a killed child. */
function createRefreshLock(symbol: string): string | null {
    const lockPath = getLockFile(symbol);
    ensureCacheDirExists();

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            closeSync(openSync(lockPath, 'wx'));
            return lockPath;
        } catch {
            try {
                if (Date.now() - statSync(lockPath).mtimeMs <= REFRESH_LOCK_STALE_MS) {
                    return null;
                }
                rmSync(lockPath, { force: true });
            } catch {
                return null;
            }
        }
    }
    return null;
}

function releaseRefreshLock(lockPath: string): void {
    try {
        rmSync(lockPath, { force: true });
    } catch {
        // Ignore lock file errors
    }
}

function spawnRefreshChild(symbol: string, lockPath: string, model: string, language: AdviceLanguage, useNews: boolean): void {
    const scriptPath = process.argv[1];
    if (!scriptPath) {
        releaseRefreshLock(lockPath);
        return;
    }

    try {
        const child = spawn(
            process.execPath,
            [scriptPath, BTC_ADVICE_REFRESH_FLAG, symbol, lockPath, model, language, useNews ? 'news' : 'chart-only'],
            { detached: true, stdio: 'ignore', windowsHide: true }
        );
        child.unref();
    } catch {
        releaseRefreshLock(lockPath);
    }
}

function scheduleRefresh(symbol: string, model: string, language: AdviceLanguage, useNews: boolean): void {
    const lockPath = createRefreshLock(symbol);
    if (lockPath) {
        spawnRefreshChild(symbol, lockPath, model, language, useNews);
    }
}

/**
 * Ask again right now, ignoring the interval - what the report page's Refresh
 * button calls. False when an ask is already in flight; that one will land.
 */
export function forceRefreshBtcAdvice(symbol: string, model: string, language: AdviceLanguage, useNews: boolean): boolean {
    const lockPath = createRefreshLock(symbol);
    if (!lockPath) {
        return false;
    }
    spawnRefreshChild(symbol, lockPath, model, language, useNews);
    return true;
}

// The widget knows the model, language and interval to use; the report server
// and the CLI do not, so the render path leaves them on disk next to the cache.
const AdviceOptionsSchema = z.object({
    model: z.string(),
    language: z.enum(['zh', 'en']),
    news: z.boolean(),
    intervalMinutes: z.number()
});

export type AdviceOptions = z.infer<typeof AdviceOptionsSchema>;

const DEFAULT_ADVICE_OPTIONS: AdviceOptions = {
    model: DEFAULT_ADVICE_MODEL,
    language: 'zh',
    news: true,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES
};

function getOptionsFile(symbol: string): string {
    return path.join(CACHE_DIR, `btc-options-${symbol}.json`);
}

export function readAdviceOptions(symbol: string): AdviceOptions {
    try {
        const parsed = AdviceOptionsSchema.safeParse(JSON.parse(readFileSync(getOptionsFile(symbol), 'utf8')));
        return parsed.success ? parsed.data : DEFAULT_ADVICE_OPTIONS;
    } catch {
        return DEFAULT_ADVICE_OPTIONS;
    }
}

/** Written only when it would change, so a render is a read and nothing more. */
function persistAdviceOptions(symbol: string, options: AdviceOptions): void {
    const current = readAdviceOptions(symbol);
    if (current.model === options.model && current.language === options.language
        && current.news === options.news && current.intervalMinutes === options.intervalMinutes) {
        return;
    }

    try {
        ensureCacheDirExists();
        writeFileSync(getOptionsFile(symbol), JSON.stringify(options));
    } catch {
        // Best-effort: the server falls back to defaults
    }
}

/** News lookup is the default; turn it off for a cheaper, chart-only ask. */
export function isNewsEnabled(item: WidgetItem): boolean {
    return item.metadata?.news !== 'false';
}

/**
 * The verdict to draw right now, plus a background refresh when it has aged
 * past the widget's interval. Never blocks: a first run returns null and the
 * next render picks up whatever the detached ask wrote.
 */
export function getBtcAdvice(item: WidgetItem, marketAvailable: boolean): BtcAdvice | null {
    const symbol = getWidgetSymbol(item);
    const cached = readCachedBtcAdvice(symbol);
    const intervalMinutes = getAdviceIntervalMinutes(item);
    const model = getAdviceModel(item);
    const language = getAdviceLanguage(item);
    const news = isNewsEnabled(item);

    persistAdviceOptions(symbol, { model, language, news, intervalMinutes });

    if (marketAvailable && isAdviceStale(cached, intervalMinutes)) {
        scheduleRefresh(symbol, model, language, news);
    }

    return cached;
}

/**
 * True while an ask is running. The refresh lock is held for exactly that
 * window, so the status line can say "asking" instead of looking frozen for
 * the ~30s a news-searching ask takes.
 */
export function isAskInFlight(symbol: string, advice: BtcAdvice | null): boolean {
    try {
        const lockedAt = statSync(getLockFile(symbol)).mtimeMs;
        if (Date.now() - lockedAt >= REFRESH_LOCK_STALE_MS) {
            return false;
        }
        // A lock older than the answer belongs to the ask that already wrote it:
        // the child died before releasing it, so nothing is running.
        return advice === null || lockedAt > advice.askedAt;
    } catch {
        return false;
    }
}

export function hasBtcAdviceWidgets(lines: WidgetItem[][]): boolean {
    return lines.some(line => line.some(item => item.type === BTC_ADVICE_WIDGET_TYPE));
}

// --- The ask itself (runs only in the detached child) ---

function resolveClaudeBinary(): string {
    const configured = process.env.CCSTATUSLINE_CLAUDE_BIN?.trim();
    if (configured?.length) {
        return configured;
    }

    const home = os.homedir();
    for (const candidate of [
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude')
    ]) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return 'claude';   // fall back to PATH resolution
}

function buildSystemPrompt(language: AdviceLanguage, useNews: boolean): string {
    const languageRule = language === 'zh'
        ? '"reason" 和 "catalyst" 用中文，各不超过 30 字。'
        : '"reason" and "catalyst" are English, at most 15 words each.';

    const method = useNews
        ? [
            'You have WebSearch and WebFetch. Work in this order.',
            '1) Search for what has moved this asset in the last 24-48 hours:',
            'macro prints (CPI, PCE, payrolls), Fed decisions and speeches, ETF flows,',
            'regulation and enforcement, exchange failures and large liquidations,',
            'and posts by the political or market figures this market reacts to.',
            '2) Name the dominant driver in "catalyst" and cite up to 3 source domains in "sources".',
            '3) Only then read the price snapshot in the light of that news:',
            'a drop into a hostile catalyst is not the same trade as a drop into silence.',
            'Two or three searches is enough - this runs on a timer.'
        ].join(' ')
        : 'Judge from the price snapshot alone. Leave "catalyst" empty and "sources" as [].';

    return [
        'You are a crypto market analyst embedded in a terminal status line.',
        'Judge the next 24-72 hours.',
        method,
        'Output exactly one line of JSON, no markdown fence, no prose before or after:',
        '{"verdict":"BUY|HOLD|SELL","confidence":<integer 0-100>,"reason":"...","catalyst":"...","sources":["...","..."]}',
        languageRule
    ].join(' ');
}

function buildUserPrompt(market: BtcMarketData, useNews: boolean): string {
    const snapshot = {
        symbol: market.symbol,
        price: market.price,
        change1h: market.change1h,
        change24h: market.change24h,
        change7d: market.change7d,
        change30d: market.change30d,
        high24h: market.high24h,
        low24h: market.low24h,
        ma7: market.ma7,
        ma30: market.ma30,
        rsi14_daily: market.rsi14,
        rangePosition60d: market.rangePosition60d,
        fearGreed: market.fearGreed,
        dailyCloses: barCloses(market.dailyBars).slice(-30).map(close => Math.round(close * 100) / 100)
    };

    return [
        `Today is ${new Date().toISOString().slice(0, 10)} (UTC). Live snapshot of ${market.symbol}`,
        '(dailyCloses = last 30 daily closes, oldest first; MA and RSI are daily):',
        JSON.stringify(snapshot),
        useNews
            ? 'Find out what is driving this move, then tell me: do you recommend buying right now? Answer with the single JSON line only.'
            : 'Do you recommend buying right now? Answer with the single JSON line only.'
    ].join('\n');
}

/**
 * The prompt goes in on stdin, never as a positional argument: several claude
 * flags (--allowedTools, --mcp-config) are variadic and would swallow a trailing
 * prompt as one of their own values.
 */
function runClaude(binary: string, args: string[], prompt: string): string {
    return execFileSync(binary, args, {
        input: prompt,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        cwd: CACHE_DIR,        // no CLAUDE.md here: the ask sees only what we pass
        timeout: ASK_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, CCSTATUSLINE_BTC_ADVICE: '1' }
    });
}

/** With CCSTATUSLINE_BTC_DEBUG=1 the raw answer lands next to the cache, which
 *  is the only way to see what a detached ask actually said. */
function traceRawAnswer(raw: string): string {
    if (process.env.CCSTATUSLINE_BTC_DEBUG === '1') {
        try {
            writeFileSync(path.join(CACHE_DIR, 'btc-advice-raw.txt'), raw);
        } catch {
            // Debug aid only
        }
    }
    return raw;
}

function askClaude(market: BtcMarketData, model: string, language: AdviceLanguage, useNews: boolean): string {
    const binary = resolveClaudeBinary();
    const baseArgs = [
        '-p',
        '--model', model,
        '--output-format', 'json',
        '--system-prompt', buildSystemPrompt(language, useNews)
    ];
    const userPrompt = buildUserPrompt(market, useNews);

    try {
        return traceRawAnswer(runClaude(binary, [
            ...baseArgs,
            // --restricted keeps Bash/Edit/REPL out of the ask; the search tools
            // are allowlisted explicitly so headless mode never stops to ask.
            '--restricted',
            '--no-session-persistence',
            '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
            ...(useNews ? ['--allowedTools', 'WebSearch,WebFetch'] : [])
        ], userPrompt));
    } catch {
        // An older claude may not know those flags; retry with the portable set.
        return traceRawAnswer(runClaude(binary, baseArgs, userPrompt));
    }
}

function normalizeSources(raw: unknown): string[] {
    const list = typeof raw === 'string'
        ? raw.split(',')
        : Array.isArray(raw) ? raw : [];

    return list
        .map(entry => String(entry).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter(entry => entry.length > 0)
        .slice(0, MAX_SOURCES)
        .map(entry => entry.slice(0, MAX_SOURCE_LENGTH));
}

/** Pull the model's answer out of `claude --output-format json`, then out of
 *  whatever prose it may have wrapped the JSON object in. */
export function parseAdviceResponse(stdout: string): {
    verdict: BtcVerdict;
    confidence: number;
    reason: string;
    catalyst: string;
    sources: string[];
} {
    let text = stdout;
    try {
        const envelope = JSON.parse(stdout) as { result?: unknown };
        if (typeof envelope.result === 'string') {
            text = envelope.result;
        }
    } catch {
        // Not the JSON envelope; treat stdout as the raw answer
    }

    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) {
        throw new Error('no JSON object in response');
    }

    const parsed = z.object({
        verdict: z.string(),
        confidence: z.union([z.number(), z.string()]).optional(),
        reason: z.string().optional(),
        catalyst: z.string().optional(),
        sources: z.unknown().optional()
    }).parse(JSON.parse(match[0]));

    const verdict = parsed.verdict.trim().toUpperCase();
    if (verdict !== 'BUY' && verdict !== 'HOLD' && verdict !== 'SELL') {
        throw new Error(`unexpected verdict ${parsed.verdict}`);
    }

    const rawConfidence = Number(parsed.confidence ?? 50);
    return {
        verdict,
        confidence: Number.isFinite(rawConfidence) ? Math.min(100, Math.max(0, Math.round(rawConfidence))) : 50,
        reason: (parsed.reason ?? '').trim().slice(0, MAX_REASON_LENGTH),
        catalyst: (parsed.catalyst ?? '').trim().slice(0, MAX_CATALYST_LENGTH),
        sources: normalizeSources(parsed.sources)
    };
}

export async function refreshBtcAdviceFromCli(
    symbol: string,
    lockPath: string,
    model: string,
    language: AdviceLanguage,
    useNews: boolean
): Promise<void> {
    try {
        const market = await fetchBtcMarket(symbol);
        if (!market) {
            writeCachedBtcAdvice({ symbol, askedAt: Date.now(), model, error: 'no market data' });
            return;
        }

        const answer = parseAdviceResponse(askClaude(market, model, language, useNews));
        writeCachedBtcAdvice({
            symbol,
            askedAt: Date.now(),
            model,
            price: market.price,
            newsUsed: useNews,
            ...answer
        });
    } catch (error) {
        // Cache the failure too: without it every render would retry the ask.
        writeCachedBtcAdvice({
            symbol,
            askedAt: Date.now(),
            model,
            error: error instanceof Error ? error.message.slice(0, 200) : 'ask failed'
        });
    } finally {
        releaseRefreshLock(lockPath);
    }
}

/** `ccstatusline --btc-advice [SYMBOL]`: the whole answer, which never fits on
 *  the status line itself. */
export function formatAdviceForCli(symbol: string): string {
    const advice = readCachedBtcAdvice(symbol);
    if (!advice) {
        return `${symbol}: no advice cached yet - add the Crypto Advice widget and wait for the next ask.`;
    }

    const askedAt = new Date(advice.askedAt).toLocaleString();
    if (advice.error) {
        return [`${symbol}: last ask failed at ${askedAt}`, `  error: ${advice.error}`, `  model: ${advice.model}`].join('\n');
    }

    const lines = [
        `${symbol}  ${advice.verdict ?? '?'}  confidence ${advice.confidence ?? '?'}`,
        `  asked:    ${askedAt}${advice.newsUsed ? ' (with news search)' : ' (chart only)'}`,
        `  price:    ${advice.price ?? '?'}`,
        `  reason:   ${advice.reason ?? '-'}`
    ];
    if (advice.catalyst) {
        lines.push(`  catalyst: ${advice.catalyst}`);
    }
    if (advice.sources?.length) {
        lines.push(`  sources:  ${advice.sources.join(', ')}`);
    }
    lines.push(`  model:    ${advice.model}`);
    lines.push('  Not investment advice.');
    return lines.join('\n');
}
