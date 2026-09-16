import * as fs from 'fs';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import type { WidgetItem } from '../types/Widget';

// Crypto spot quotes for the statusline. Structured like claude-service-status:
// a short-lived disk cache shared across invocations plus a failure lock, so an
// unreachable exchange cannot cost a network round trip on every render.
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const CACHE_MAX_AGE = 60;        // seconds - a spot price older than this is refetched
const FAILURE_BACKOFF = 30;      // seconds - wait before retrying after a failed fetch
const REQUEST_TIMEOUT_MS = 4000;

export const DEFAULT_CRYPTO_SYMBOL = 'BTCUSDT';
export const BTC_PRICE_WIDGET_TYPE = 'btc-price';
export const BTC_TREND_WIDGET_TYPE = 'btc-trend';
export const BTC_ADVICE_WIDGET_TYPE = 'btc-advice';

// btc-advice needs the same quote: its verdict is derived from this snapshot.
const MARKET_WIDGET_TYPES = new Set<string>([
    BTC_PRICE_WIDGET_TYPE,
    BTC_TREND_WIDGET_TYPE,
    BTC_ADVICE_WIDGET_TYPE
]);

export interface FearGreedIndex {
    value: number;
    label: string;
}

/** One candle, oldest-first in the arrays below. `t` is the open time in ms. */
export interface Bar {
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
}

export function barCloses(bars: readonly Bar[]): number[] {
    return bars.map(bar => bar.c);
}

export interface BtcMarketData {
    symbol: string;
    source: 'binance' | 'okx';
    fetchedAt: number;           // epoch ms
    price: number;
    change1h?: number;           // percent
    change24h: number;           // percent
    change7d?: number;           // percent
    change30d?: number;          // percent
    high24h: number;
    low24h: number;
    ma7?: number;
    ma30?: number;
    rsi14?: number;              // Wilder RSI on daily closes
    rangePosition60d?: number;   // 0 = 60d low, 100 = 60d high
    hourlyBars: Bar[];           // oldest first, up to 48
    dailyBars: Bar[];            // oldest first, up to 30
    fearGreed?: FearGreedIndex;
}

export type BtcMarketMap = Record<string, BtcMarketData>;

const FearGreedSchema = z.object({ value: z.number(), label: z.string() });

const BarSchema = z.object({
    t: z.number(),
    o: z.number(),
    h: z.number(),
    l: z.number(),
    c: z.number()
});

const BtcMarketDataSchema = z.object({
    symbol: z.string(),
    source: z.enum(['binance', 'okx']),
    fetchedAt: z.number(),
    price: z.number(),
    change1h: z.number().optional(),
    change24h: z.number(),
    change7d: z.number().optional(),
    change30d: z.number().optional(),
    high24h: z.number(),
    low24h: z.number(),
    ma7: z.number().optional(),
    ma30: z.number().optional(),
    rsi14: z.number().optional(),
    rangePosition60d: z.number().optional(),
    hourlyBars: z.array(BarSchema),
    dailyBars: z.array(BarSchema),
    fearGreed: FearGreedSchema.optional()
});

// Memory cache so several btc widgets in one invocation share a single lookup
const memoryCache = new Map<string, BtcMarketData>();

/** Uppercased, stripped of anything an exchange path would not accept. */
export function normalizeSymbol(raw: string | undefined): string {
    const cleaned = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return cleaned.length > 0 ? cleaned : DEFAULT_CRYPTO_SYMBOL;
}

/** BTCUSDT -> BTC-USDT. OKX is the fallback venue and wants the dashed form. */
function toOkxInstrument(symbol: string): string {
    for (const quote of ['USDT', 'USDC', 'USD', 'BTC', 'ETH']) {
        if (symbol.length > quote.length && symbol.endsWith(quote)) {
            return `${symbol.slice(0, -quote.length)}-${quote}`;
        }
    }
    return symbol;
}

export function getSymbolBase(symbol: string): string {
    const instrument = toOkxInstrument(symbol);
    const dash = instrument.indexOf('-');
    return dash === -1 ? symbol : instrument.slice(0, dash);
}

function getCacheFile(symbol: string): string {
    return path.join(CACHE_DIR, `btc-market-${symbol}.json`);
}

function getLockFile(symbol: string): string {
    return path.join(CACHE_DIR, `btc-market-${symbol}.lock`);
}

function ensureCacheDirExists(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

export function readCachedBtcMarket(symbol: string): BtcMarketData | null {
    try {
        const parsed = BtcMarketDataSchema.safeParse(JSON.parse(fs.readFileSync(getCacheFile(symbol), 'utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function writeCachedBtcMarket(data: BtcMarketData): void {
    try {
        ensureCacheDirExists();
        fs.writeFileSync(getCacheFile(data.symbol), JSON.stringify(data));
    } catch {
        // Best-effort caching
    }
}

function isFailureLockActive(symbol: string, nowSeconds: number): boolean {
    try {
        return nowSeconds - Math.floor(fs.statSync(getLockFile(symbol)).mtimeMs / 1000) < FAILURE_BACKOFF;
    } catch {
        return false;
    }
}

function writeFailureLock(symbol: string): void {
    try {
        ensureCacheDirExists();
        fs.writeFileSync(getLockFile(symbol), '');
    } catch {
        // Ignore lock file errors
    }
}

function clearFailureLock(symbol: string): void {
    try {
        fs.rmSync(getLockFile(symbol), { force: true });
    } catch {
        // Ignore lock file errors
    }
}

function getProxyUrl(): string | null {
    const proxyUrl = process.env.HTTPS_PROXY?.trim();
    return proxyUrl?.length ? proxyUrl : null;
}

function httpGetJson(hostname: string, pathName: string): Promise<unknown> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };

        let options: https.RequestOptions;
        try {
            const proxyUrl = getProxyUrl();
            options = {
                hostname,
                path: pathName,
                method: 'GET',
                timeout: REQUEST_TIMEOUT_MS,
                headers: { 'User-Agent': 'ccstatusline' },
                ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {})
            };
        } catch {
            finish(null);
            return;
        }

        const request = https.request(options, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;
            });
            response.on('end', () => {
                if (response.statusCode !== 200 || !body) {
                    finish(null);
                    return;
                }
                try {
                    finish(JSON.parse(body));
                } catch {
                    finish(null);
                }
            });
            response.on('aborted', () => { finish(null); });
            response.on('error', () => { finish(null); });
        });

        request.on('error', () => { finish(null); });
        request.on('timeout', () => {
            request.destroy();
            finish(null);
        });
        request.end();
    });
}

function toFinite(value: unknown): number | null {
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

export function sma(values: number[], period: number): number | undefined {
    if (values.length < period || period <= 0) {
        return undefined;
    }
    const window = values.slice(-period);
    return window.reduce((total, value) => total + value, 0) / period;
}

/** Wilder RSI over `period` closes. Returns undefined rather than a made-up
 *  number when the series is too short to define one. */
export function rsi(closes: number[], period = 14): number | undefined {
    if (closes.length < period + 1) {
        return undefined;
    }

    let gains = 0;
    let losses = 0;
    const window = closes.slice(-(period + 1));
    for (let i = 1; i < window.length; i++) {
        const previous = window[i - 1];
        const current = window[i];
        if (previous === undefined || current === undefined) {
            return undefined;
        }
        const delta = current - previous;
        gains += Math.max(delta, 0);
        losses += Math.max(-delta, 0);
    }

    if (losses === 0) {
        return gains === 0 ? 50 : 100;
    }
    return 100 - 100 / (1 + gains / losses);
}

function percentChange(current: number, previous: number | undefined): number | undefined {
    if (previous === undefined || previous === 0) {
        return undefined;
    }
    return (current - previous) / previous * 100;
}

function closeAt(closes: number[], barsBack: number): number | undefined {
    return closes[closes.length - 1 - barsBack];
}

/** Both venues lay a candle out as [openTime, open, high, low, close, ...];
 *  OKX just hands them back newest first. */
function parseKlineBars(payload: unknown, newestFirst: boolean): Bar[] | null {
    if (!Array.isArray(payload)) {
        return null;
    }

    const bars: Bar[] = [];
    for (const row of payload) {
        if (!Array.isArray(row)) {
            return null;
        }
        const [t, o, h, l, c] = [toFinite(row[0]), toFinite(row[1]), toFinite(row[2]), toFinite(row[3]), toFinite(row[4])];
        if (t === null || o === null || h === null || l === null || c === null) {
            return null;
        }
        bars.push({ t, o, h, l, c });
    }
    return newestFirst ? bars.reverse() : bars;
}

interface RawQuote {
    source: 'binance' | 'okx';
    price: number;
    change24h: number;
    high24h: number;
    low24h: number;
    hourlyBars: Bar[];
    dailyBars: Bar[];
}

async function fetchFromBinance(symbol: string): Promise<RawQuote | null> {
    const [ticker, hourly, daily] = await Promise.all([
        httpGetJson('api.binance.com', `/api/v3/ticker/24hr?symbol=${symbol}`),
        httpGetJson('api.binance.com', `/api/v3/klines?symbol=${symbol}&interval=1h&limit=72`),
        httpGetJson('api.binance.com', `/api/v3/klines?symbol=${symbol}&interval=1d&limit=60`)
    ]);

    if (typeof ticker !== 'object' || ticker === null) {
        return null;
    }

    const record = ticker as Record<string, unknown>;
    const price = toFinite(record.lastPrice);
    const change24h = toFinite(record.priceChangePercent);
    const high24h = toFinite(record.highPrice);
    const low24h = toFinite(record.lowPrice);
    const hourlyBars = parseKlineBars(hourly, false);
    const dailyBars = parseKlineBars(daily, false);

    if (price === null || change24h === null || high24h === null || low24h === null
        || hourlyBars === null || dailyBars === null) {
        return null;
    }

    return { source: 'binance', price, change24h, high24h, low24h, hourlyBars, dailyBars };
}

async function fetchFromOkx(symbol: string): Promise<RawQuote | null> {
    const instrument = toOkxInstrument(symbol);
    const [ticker, hourly, daily] = await Promise.all([
        httpGetJson('www.okx.com', `/api/v5/market/ticker?instId=${instrument}`),
        httpGetJson('www.okx.com', `/api/v5/market/candles?instId=${instrument}&bar=1H&limit=72`),
        httpGetJson('www.okx.com', `/api/v5/market/candles?instId=${instrument}&bar=1D&limit=60`)
    ]);

    const tickerRow = (ticker as { data?: unknown } | null)?.data;
    const first = Array.isArray(tickerRow) ? (tickerRow[0] as Record<string, unknown> | undefined) : undefined;
    if (!first) {
        return null;
    }

    const price = toFinite(first.last);
    const open24h = toFinite(first.open24h);
    const high24h = toFinite(first.high24h);
    const low24h = toFinite(first.low24h);
    // OKX returns candles newest first
    const hourlyBars = parseKlineBars((hourly as { data?: unknown } | null)?.data, true);
    const dailyBars = parseKlineBars((daily as { data?: unknown } | null)?.data, true);

    if (price === null || open24h === null || open24h === 0 || high24h === null || low24h === null
        || hourlyBars === null || dailyBars === null) {
        return null;
    }

    return {
        source: 'okx',
        price,
        change24h: (price - open24h) / open24h * 100,
        high24h,
        low24h,
        hourlyBars,
        dailyBars
    };
}

async function fetchFearGreed(): Promise<FearGreedIndex | undefined> {
    const payload = await httpGetJson('api.alternative.me', '/fng/?limit=1');
    const rows = (payload as { data?: unknown } | null)?.data;
    const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
    const value = toFinite(first?.value);
    const label = first?.value_classification;
    if (value === null || typeof label !== 'string') {
        return undefined;
    }
    return { value, label };
}

function buildMarketData(symbol: string, quote: RawQuote, fearGreed: FearGreedIndex | undefined): BtcMarketData {
    const { price } = quote;
    // Indicators use the full series; only the stored tail is trimmed
    const dailyCloses = barCloses(quote.dailyBars);
    const hourlyCloses = barCloses(quote.hourlyBars);
    const high60d = dailyCloses.length > 0 ? Math.max(...dailyCloses) : undefined;
    const low60d = dailyCloses.length > 0 ? Math.min(...dailyCloses) : undefined;
    const rangeSpan = high60d !== undefined && low60d !== undefined ? high60d - low60d : 0;

    return {
        symbol,
        source: quote.source,
        fetchedAt: Date.now(),
        price,
        change1h: percentChange(price, closeAt(hourlyCloses, 1)),
        change24h: quote.change24h,
        change7d: percentChange(price, closeAt(dailyCloses, 7)),
        change30d: percentChange(price, closeAt(dailyCloses, 30)),
        high24h: quote.high24h,
        low24h: quote.low24h,
        ma7: sma(dailyCloses, 7),
        ma30: sma(dailyCloses, 30),
        rsi14: rsi(dailyCloses, 14),
        rangePosition60d: rangeSpan > 0 && low60d !== undefined ? (price - low60d) / rangeSpan * 100 : undefined,
        hourlyBars: quote.hourlyBars.slice(-48),
        dailyBars: quote.dailyBars.slice(-30),
        ...(fearGreed ? { fearGreed } : {})
    };
}

/**
 * Current quote for `symbol`, from memory, then disk, then the network.
 * Serves a stale cache rather than nothing when every venue is unreachable.
 */
export async function fetchBtcMarket(symbol: string): Promise<BtcMarketData | null> {
    const nowSeconds = Math.floor(Date.now() / 1000);

    const cachedInMemory = memoryCache.get(symbol);
    if (cachedInMemory && nowSeconds - Math.floor(cachedInMemory.fetchedAt / 1000) < CACHE_MAX_AGE) {
        return cachedInMemory;
    }

    const diskCache = readCachedBtcMarket(symbol);
    if (diskCache && nowSeconds - Math.floor(diskCache.fetchedAt / 1000) < CACHE_MAX_AGE) {
        memoryCache.set(symbol, diskCache);
        return diskCache;
    }

    if (isFailureLockActive(symbol, nowSeconds)) {
        return diskCache;
    }

    const quote = await fetchFromBinance(symbol) ?? await fetchFromOkx(symbol);
    if (!quote) {
        writeFailureLock(symbol);
        return diskCache;
    }

    clearFailureLock(symbol);
    const data = buildMarketData(symbol, quote, await fetchFearGreed());
    memoryCache.set(symbol, data);
    writeCachedBtcMarket(data);
    return data;
}

export function getWidgetSymbol(item: WidgetItem): string {
    return normalizeSymbol(item.metadata?.symbol);
}

export function hasBtcWidgets(lines: WidgetItem[][]): boolean {
    return lines.some(line => line.some(item => MARKET_WIDGET_TYPES.has(item.type)));
}

function getRequestedSymbols(lines: WidgetItem[][]): string[] {
    const symbols = new Set<string>();
    for (const line of lines) {
        for (const item of line) {
            if (MARKET_WIDGET_TYPES.has(item.type)) {
                symbols.add(getWidgetSymbol(item));
            }
        }
    }
    return Array.from(symbols);
}

export async function prefetchBtcMarketIfNeeded(lines: WidgetItem[][]): Promise<BtcMarketMap | null> {
    const symbols = getRequestedSymbols(lines);
    if (symbols.length === 0) {
        return null;
    }

    const entries = await Promise.all(symbols.map(async symbol => [symbol, await fetchBtcMarket(symbol)] as const));
    const map: BtcMarketMap = {};
    for (const [symbol, data] of entries) {
        if (data) {
            map[symbol] = data;
        }
    }
    return map;
}
