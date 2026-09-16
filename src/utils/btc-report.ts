import { spawn } from 'child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

import type {
    Bar,
    BtcMarketData
} from './btc';
import {
    fetchBtcMarket,
    readCachedBtcMarket
} from './btc';
import type { BtcAdvice } from './btc-advice';
import {
    forceRefreshBtcAdvice,
    readAdviceOptions,
    readCachedBtcAdvice
} from './btc-advice';
import type { Ledger } from './btc-ledger';
import {
    HORIZONS,
    hasDueScoring,
    readLedger,
    scheduleScoring,
    summarize
} from './btc-ledger';

// A status line cannot hold a report, and a terminal cannot hold a button - it
// can only open a URL. So the widget links to a small local server: one page
// with the whole answer (when it was given, what it read, which news), a real
// candlestick chart, and a Refresh button that triggers the ask on the spot.
//
// The server is started on demand by the widget, binds 127.0.0.1 on an
// arbitrary port, and exits on its own once nobody has opened it for a while.
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ccstatusline');
const STATE_FILE = path.join(CACHE_DIR, 'btc-server.json');
const START_LOCK = path.join(CACHE_DIR, 'btc-server.lock');
const START_LOCK_STALE_MS = 30_000;
const IDLE_EXIT_MS = 60 * 60_000;

export const BTC_SERVER_FLAG = '--internal-btc-server';

const ServerStateSchema = z.object({ port: z.number(), pid: z.number(), startedAt: z.number() });

function ensureCacheDirExists(): void {
    if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function readServerState(): { port: number; pid: number; startedAt: number } | null {
    try {
        const parsed = ServerStateSchema.safeParse(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Port of the running report server, starting one if the recorded process is
 * gone. Returns null on the render that starts it; the next render links.
 */
export function ensureReportServer(): number | null {
    const state = readServerState();
    if (state && isProcessAlive(state.pid)) {
        return state.port;
    }

    const scriptPath = process.argv[1];
    if (!scriptPath) {
        return null;
    }

    // One starter at a time, even when several lines render at once
    try {
        ensureCacheDirExists();
        if (existsSync(START_LOCK) && Date.now() - Number(readFileSync(START_LOCK, 'utf8')) < START_LOCK_STALE_MS) {
            return null;
        }
        writeFileSync(START_LOCK, String(Date.now()));
    } catch {
        return null;
    }

    try {
        const child = spawn(process.execPath, [scriptPath, BTC_SERVER_FLAG], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();
    } catch {
        rmSync(START_LOCK, { force: true });
    }
    return null;
}

export function getReportUrl(symbol: string, port: number, refresh = false): string {
    return `http://127.0.0.1:${port}/?symbol=${encodeURIComponent(symbol)}${refresh ? '&refresh=1' : ''}`;
}

// --- the page ---

function candlestickSvg(bars: Bar[], width = 720, height = 260): string {
    if (bars.length === 0) {
        return '<p class="muted">no candles</p>';
    }

    const padding = { top: 12, right: 56, bottom: 18, left: 8 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const high = Math.max(...bars.map(bar => bar.h));
    const low = Math.min(...bars.map(bar => bar.l));
    const span = high - low || 1;
    const slot = plotWidth / bars.length;
    const bodyWidth = Math.max(1.5, slot * 0.62);
    const y = (value: number): number => padding.top + (high - value) / span * plotHeight;

    const candles = bars.map((bar, index) => {
        const centerX = padding.left + slot * (index + 0.5);
        const up = bar.c >= bar.o;
        const bodyTop = y(Math.max(bar.o, bar.c));
        const bodyHeight = Math.max(1, y(Math.min(bar.o, bar.c)) - bodyTop);
        const cls = up ? 'up' : 'down';
        return `<line class="${cls}" x1="${centerX.toFixed(1)}" x2="${centerX.toFixed(1)}" y1="${y(bar.h).toFixed(1)}" y2="${y(bar.l).toFixed(1)}" />`
            + `<rect class="${cls}" x="${(centerX - bodyWidth / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${bodyHeight.toFixed(1)}" />`;
    }).join('');

    const gridlines = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const value = high - span * fraction;
        const lineY = padding.top + fraction * plotHeight;
        return `<line class="grid" x1="${padding.left}" x2="${padding.left + plotWidth}" y1="${lineY.toFixed(1)}" y2="${lineY.toFixed(1)}" />`
            + `<text class="axis" x="${padding.left + plotWidth + 6}" y="${(lineY + 4).toFixed(1)}">${value.toFixed(value >= 1000 ? 0 : 2)}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="candlestick chart">${gridlines}${candles}</svg>`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[character] ?? character));
}

function formatNumber(value: number | undefined, digits = 2): string {
    return value === undefined ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function renderAdviceSection(advice: BtcAdvice | null, intervalMinutes: number): string {
    if (!advice) {
        return '<p class="muted">还没有结论 —— 第一次询问正在排队。</p>';
    }

    if (advice.error) {
        return `<p class="verdict err">上次询问失败</p><p class="muted">${escapeHtml(advice.error)}</p>`;
    }

    const verdictClass = advice.verdict === 'BUY' ? 'up' : advice.verdict === 'SELL' ? 'down' : 'flat';
    const nextAsk = new Date(advice.askedAt + intervalMinutes * 60_000).toLocaleTimeString();
    const sources = (advice.sources ?? [])
        .map(source => `<a href="https://${escapeHtml(source)}" target="_blank" rel="noreferrer">${escapeHtml(source)}</a>`)
        .join(' · ');

    return [
        `<p class="verdict ${verdictClass}">${escapeHtml(advice.verdict ?? '?')}<span class="confidence">信心 ${advice.confidence ?? '?'}</span></p>`,
        `<dl>`,
        `<dt>给出时间</dt><dd>${new Date(advice.askedAt).toLocaleString()} <span class="muted" data-age>（${Math.round((Date.now() - advice.askedAt) / 60000)} 分钟前）</span></dd>`,
        `<dt>依据</dt><dd>${escapeHtml(advice.reason ?? '—')}</dd>`,
        `<dt>新闻催化剂</dt><dd>${advice.catalyst ? escapeHtml(advice.catalyst) : '—'}</dd>`,
        `<dt>信息源</dt><dd>${sources || '—'}</dd>`,
        `<dt>当时价格</dt><dd>${formatNumber(advice.price)}</dd>`,
        `<dt>模型</dt><dd>${escapeHtml(advice.model)} ${advice.newsUsed ? '（带新闻检索）' : '（仅技术面）'}</dd>`,
        `<dt>下次自动询问</dt><dd>${nextAsk}（每 ${intervalMinutes} 分钟）</dd>`,
        `</dl>`
    ].join('');
}

function renderMarketSection(market: BtcMarketData | null): string {
    if (!market) {
        return '<p class="muted">行情暂时取不到。</p>';
    }

    const rows: [string, string][] = [
        ['现价', formatNumber(market.price)],
        ['1h / 24h', `${formatNumber(market.change1h)}% / ${formatNumber(market.change24h)}%`],
        ['7d / 30d', `${formatNumber(market.change7d)}% / ${formatNumber(market.change30d)}%`],
        ['24h 高 / 低', `${formatNumber(market.high24h)} / ${formatNumber(market.low24h)}`],
        ['MA7 / MA30', `${formatNumber(market.ma7)} / ${formatNumber(market.ma30)}`],
        ['RSI(14, 日线)', formatNumber(market.rsi14, 1)],
        ['60 日区间位置', `${formatNumber(market.rangePosition60d, 1)}%`],
        ['恐惧贪婪指数', market.fearGreed ? `${market.fearGreed.value} (${escapeHtml(market.fearGreed.label)})` : '—'],
        ['数据源', `${market.source} · ${new Date(market.fetchedAt).toLocaleTimeString()}`]
    ];

    return `<table>${rows.map(([key, value]) => `<tr><th>${key}</th><td>${value}</td></tr>`).join('')}</table>`;
}

function renderAccuracySection(ledger: Ledger): string {
    if (ledger.entries.length === 0) {
        return '<p class="muted">还没有记录。每次询问都会入账，到期后用真实行情结算。</p>';
    }

    const percent = (value: number | null): string => (value === null ? '—' : `${value.toFixed(0)}%`);
    const rows = HORIZONS.map((horizon) => {
        const summary = summarize(ledger, { horizonId: horizon.id });
        const edge = summary.rate !== null && summary.baselineRate !== null
            ? summary.rate - summary.baselineRate
            : null;
        const edgeClass = edge === null ? '' : edge > 5 ? 'up' : edge < -5 ? 'down' : 'flat';
        return `<tr>
            <th>${horizon.id}</th>
            <td>${summary.n}</td>
            <td>${percent(summary.rate)}${summary.n > 0 ? ` <span class="muted">(${summary.hits}/${summary.n})</span>` : ''}</td>
            <td>${percent(summary.baselineRate)}${summary.baselineVerdict ? ` <span class="muted">(一直喊 ${summary.baselineVerdict})</span>` : ''}</td>
            <td class="${edgeClass}">${edge === null ? '—' : `${edge >= 0 ? '+' : ''}${edge.toFixed(0)}pt`}</td>
        </tr>`;
    }).join('');

    const main = summarize(ledger);
    const recent = [...ledger.entries].sort((left, right) => right.askedAt - left.askedAt).slice(0, 12).map((entry) => {
        const outcome = entry.outcomes[main.horizon.id];
        const result = outcome
            ? `<span class="${outcome.hit ? 'up' : 'down'}">${outcome.hit ? '命中' : '未中'}</span> <span class="muted">${outcome.changePercent >= 0 ? '+' : ''}${outcome.changePercent.toFixed(1)}%</span>`
            : '<span class="muted">未到期</span>';
        return `<tr>
            <th>${new Date(entry.askedAt).toLocaleString()}</th>
            <td>${escapeHtml(entry.verdict)}</td>
            <td>${entry.confidence}</td>
            <td>${formatNumber(entry.price, 0)}</td>
            <td>${result}</td>
            <td class="muted">${entry.catalyst ? escapeHtml(entry.catalyst) : ''}</td>
        </tr>`;
    }).join('');

    return `
        <p class="muted">判定标准：${main.horizon.id} 后涨跌超过 ${ledger.thresholdPercent}% 才算方向成立，买入要涨到、卖出要跌到、观望要求确实没走出这个区间。
        统计每 6 小时最多取一条，免得忙碌的一天盖过安静的一周。“一直喊同一句”是同一批样本下最好的固定答案能拿到的成绩 —— 跑不赢它就等于没信息。</p>
        <table>
            <tr><th>周期</th><th>样本</th><th>命中率</th><th>一直喊同一句</th><th>差值</th></tr>
            ${rows}
        </table>
        <h2 style="margin-top:20px">最近的判断（按 ${main.horizon.id} 结算）</h2>
        <table>
            <tr><th>时间</th><th>判断</th><th>信心</th><th>当时价格</th><th>结果</th><th>当时的催化剂</th></tr>
            ${recent}
        </table>`;
}

function renderPage(symbol: string, market: BtcMarketData | null, advice: BtcAdvice | null, intervalMinutes: number, autoRefresh: boolean, ledger: Ledger): string {
    const bars = market ? (market.hourlyBars.length > 0 ? market.hourlyBars : market.dailyBars) : [];
    const dailyBars = market?.dailyBars ?? [];

    return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(symbol)} · ccstatusline</title>
<style>
:root { color-scheme: light dark; --up: #16a34a; --down: #dc2626; --flat: #ca8a04; --muted: #71717a; }
body { margin: 0; padding: 24px; font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 860px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 28px 0 8px; }
.muted { color: var(--muted); }
.verdict { font-size: 32px; font-weight: 700; margin: 8px 0 12px; }
.verdict.up { color: var(--up); } .verdict.down { color: var(--down); } .verdict.flat { color: var(--flat); }
.verdict.err { color: var(--down); font-size: 20px; }
.confidence { font-size: 14px; font-weight: 400; color: var(--muted); margin-left: 12px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0; }
dt { color: var(--muted); } dd { margin: 0; }
table { border-collapse: collapse; } th, td { text-align: left; padding: 3px 20px 3px 0; font-weight: 400; } th { color: var(--muted); }
svg { width: 100%; height: auto; }
svg line.up, svg rect.up { stroke: var(--up); fill: var(--up); }
svg line.down, svg rect.down { stroke: var(--down); fill: var(--down); }
svg line.grid { stroke: currentColor; opacity: .12; }
svg text.axis { fill: var(--muted); font-size: 10px; }
.up { color: var(--up); } .down { color: var(--down); } .flat { color: var(--flat); }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
button[disabled] { opacity: .5; cursor: progress; }
.row { display: flex; gap: 12px; align-items: center; }
.tabs button { padding: 2px 10px; font-size: 12px; }
.tabs button[aria-pressed="true"] { background: currentColor; }
.tabs button[aria-pressed="true"] span { color: Canvas; }
footer { margin-top: 32px; color: var(--muted); font-size: 12px; }
</style></head>
<body data-symbol="${escapeHtml(symbol)}">
<h1>${escapeHtml(symbol)} <span class="muted">${market ? formatNumber(market.price) : ''}</span></h1>
<div class="row">
  <button id="refresh">立即重新询问</button>
  <span id="status" class="muted"></span>
</div>

<h2>Claude 的判断</h2>
<div id="advice">${renderAdviceSection(advice, intervalMinutes)}</div>

<h2>K 线</h2>
<div class="row tabs">
  <button data-range="1h" aria-pressed="true"><span>小时线</span></button>
  <button data-range="1d" aria-pressed="false"><span>日线</span></button>
</div>
<div id="chart-1h">${candlestickSvg(bars)}</div>
<div id="chart-1d" hidden>${candlestickSvg(dailyBars)}</div>

<h2>预测准确率</h2>
<div id="accuracy">${renderAccuracySection(ledger)}</div>

<h2>行情快照</h2>
<div id="market">${renderMarketSection(market)}</div>

<footer>本页由 ccstatusline 在本机生成，数据来自 Binance/OKX 与一次 Claude 询问。判断由语言模型给出，不构成投资建议。</footer>

<script>
const symbol = document.body.dataset.symbol;
const statusEl = document.getElementById('status');
const button = document.getElementById('refresh');

for (const tab of document.querySelectorAll('.tabs button')) {
    tab.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.tabs button')) {
            other.setAttribute('aria-pressed', String(other === tab));
        }
        document.getElementById('chart-1h').hidden = tab.dataset.range !== '1h';
        document.getElementById('chart-1d').hidden = tab.dataset.range !== '1d';
    });
}

async function refresh() {
    button.disabled = true;
    statusEl.textContent = '正在查新闻并重新判断…（约 30 秒）';
    const before = Number(document.body.dataset.askedAt || 0);
    try {
        await fetch('/api/refresh?symbol=' + encodeURIComponent(symbol), { method: 'POST' });
    } catch (error) {
        statusEl.textContent = '触发失败：' + error;
        button.disabled = false;
        return;
    }
    for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const state = await (await fetch('/api/state?symbol=' + encodeURIComponent(symbol))).json();
        if (state.advice && Number(state.advice.askedAt) > before) {
            location.reload();
            return;
        }
    }
    statusEl.textContent = '等待超时，稍后刷新页面看看。';
    button.disabled = false;
}

button.addEventListener('click', refresh);
document.body.dataset.askedAt = '${advice?.askedAt ?? 0}';
${autoRefresh ? 'refresh();' : ''}
</script>
</body></html>`;
}

// --- the server ---

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
    response.end(payload);
}

export function runBtcReportServer(): void {
    let idleTimer: NodeJS.Timeout;
    const shutdown = (): void => {
        rmSync(STATE_FILE, { force: true });
        process.exit(0);
    };
    const resetIdleTimer = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(shutdown, IDLE_EXIT_MS);
        idleTimer.unref();
    };

    const server = http.createServer((request, response) => {
        resetIdleTimer();
        // Host header is irrelevant here; we only ever bind loopback
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const symbol = (url.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();

        if (url.pathname === '/api/state') {
            void fetchBtcMarket(symbol).then((market) => {
                sendJson(response, 200, { market, advice: readCachedBtcAdvice(symbol) });
            });
            return;
        }

        if (url.pathname === '/api/refresh') {
            const options = readAdviceOptions(symbol);
            forceRefreshBtcAdvice(symbol, options.model, options.language, options.news);
            sendJson(response, 202, { started: true });
            return;
        }

        if (url.pathname === '/') {
            const options = readAdviceOptions(symbol);
            const ledger = readLedger(symbol);
            if (hasDueScoring(ledger)) {
                scheduleScoring(symbol);
            }
            void fetchBtcMarket(symbol).then((fetched) => {
                const market = fetched ?? readCachedBtcMarket(symbol);
                const page = renderPage(symbol, market, readCachedBtcAdvice(symbol), options.intervalMinutes, url.searchParams.get('refresh') === '1', ledger);
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end(page);
            });
            return;
        }

        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
    });

    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
            process.exit(1);
        }
        ensureCacheDirExists();
        writeFileSync(STATE_FILE, JSON.stringify({ port: address.port, pid: process.pid, startedAt: Date.now() }));
        rmSync(START_LOCK, { force: true });
        resetIdleTimer();
    });

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
