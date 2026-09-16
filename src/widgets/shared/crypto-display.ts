import type { ColorLevelString } from '../../types/ColorLevel';
import type { Settings } from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import type { Bar } from '../../utils/btc';
import { getColorAnsiCode } from '../../utils/colors';

// Shared presentation for the crypto widgets: direction colors, price/percent
// formatting, and the hourly sparkline.

export type TrendColorKey = 'up' | 'down' | 'flat' | 'muted';

const TREND_COLOR_SPECS: Record<TrendColorKey, Record<ColorLevelString, string>> = {
    up: { ansi16: '\x1b[32m', ansi256: 'ansi256:70', truecolor: 'hex:4e9a06' },
    down: { ansi16: '\x1b[31m', ansi256: 'ansi256:160', truecolor: 'hex:cc0000' },
    flat: { ansi16: '\x1b[33m', ansi256: 'ansi256:178', truecolor: 'hex:c4a000' },
    muted: { ansi16: '\x1b[90m', ansi256: 'ansi256:59', truecolor: 'hex:555753' }
};

const SPARKLINE_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// Braille cells carry 2 columns x 4 rows of dots, so a row of them draws a
// line chart at four times the vertical resolution of the block glyphs - which
// is what makes a trend legible when the whole move is a couple of percent.
// Bit per (column, row), rows top-down; see U+2800 dot numbering.
const BRAILLE_DOT_BITS: readonly (readonly number[])[] = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80]
];
const BRAILLE_ROWS = BRAILLE_DOT_BITS.length;
const TREND_COLORS_METADATA_KEY = 'colors';

export function getTrendFgCode(key: TrendColorKey, colorLevel: ColorLevelString): string {
    const spec = TREND_COLOR_SPECS[key][colorLevel];
    return spec.startsWith('\x1b') ? spec : getColorAnsiCode(spec, colorLevel, false);
}

export function trendKeyForChange(change: number | undefined): TrendColorKey {
    if (change === undefined || Math.abs(change) < 0.01) {
        return 'flat';
    }
    return change > 0 ? 'up' : 'down';
}

/** Opt-in: without it the item keeps whatever color the theme assigns. */
export function isTrendColorsEnabled(item: WidgetItem): boolean {
    return item.metadata?.[TREND_COLORS_METADATA_KEY] === 'true';
}

export function toggleTrendColors(item: WidgetItem): WidgetItem {
    return {
        ...item,
        metadata: {
            ...(item.metadata ?? {}),
            [TREND_COLORS_METADATA_KEY]: isTrendColorsEnabled(item) ? 'false' : 'true'
        }
    };
}

/**
 * Wrap `text` in a direction color, restoring only the default foreground so a
 * powerline background survives. Honors colorLevel 0 (colors off entirely).
 */
export function colorizeTrend(text: string, key: TrendColorKey, settings: Settings, colorLevel: ColorLevelString): string {
    if (settings.colorLevel === 0) {
        return text;
    }
    const code = getTrendFgCode(key, colorLevel);
    return code ? `${code}${text}\x1b[39m` : text;
}

function groupThousands(value: string): string {
    const [whole = '', fraction] = value.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Decimals that stay useful across a $75,000 coin and a $0.00002 one. */
export function formatPrice(price: number): string {
    const magnitude = Math.abs(price);
    const decimals = magnitude >= 1000 ? 0 : magnitude >= 1 ? 2 : magnitude >= 0.01 ? 4 : 6;
    return groupThousands(price.toFixed(decimals));
}

export function formatSignedPercent(change: number): string {
    const arrow = Math.abs(change) < 0.01 ? '' : change > 0 ? '▲' : '▼';
    return `${arrow}${Math.abs(change).toFixed(2)}%`;
}

/**
 * Merge `bars` into `buckets` longer bars - the same thing a chart does when
 * you zoom out: open of the first, close of the last, the extremes between.
 * Fewer, wider cells beat one cell per hour, whose shape is mostly noise.
 */
export function aggregateBars(bars: readonly Bar[], buckets: number): Bar[] {
    if (buckets <= 0 || bars.length === 0) {
        return [];
    }
    if (bars.length <= buckets) {
        return [...bars];
    }

    const out: Bar[] = [];
    for (let index = 0; index < buckets; index++) {
        const from = Math.floor(index * bars.length / buckets);
        const to = Math.max(from + 1, Math.floor((index + 1) * bars.length / buckets));
        const slice = bars.slice(from, to);
        const first = slice[0];
        const last = slice[slice.length - 1];
        if (!first || !last) {
            continue;
        }
        out.push({
            t: first.t,
            o: first.o,
            c: last.c,
            h: Math.max(...slice.map(bar => bar.h)),
            l: Math.min(...slice.map(bar => bar.l))
        });
    }
    return out;
}

/** Resample a series to exactly `count` points, nearest-neighbour. */
function resample(values: readonly number[], count: number): number[] {
    if (values.length === 0 || count <= 0) {
        return [];
    }
    if (values.length === count) {
        return [...values];
    }

    return Array.from({ length: count }, (unused, index) => {
        const source = Math.round(index * (values.length - 1) / Math.max(1, count - 1));
        return values[Math.min(values.length - 1, source)] ?? 0;
    });
}

/**
 * A line chart in one row of braille, two samples per cell, drawn as a
 * connected line (the span between consecutive samples is filled, so the line
 * never breaks into floating dots). One color for the whole line, from its net
 * move: coloring each cell by its own slope turns a trend into confetti.
 *
 * The vertical range is the series' own min-max, so a 1% move still uses the
 * full height - the point is the shape, not the absolute level.
 */
export function brailleline(values: readonly number[], cells: number, settings: Settings, colorLevel: ColorLevelString): string {
    const samples = resample(values, cells * 2);
    if (samples.length === 0) {
        return '';
    }

    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const span = max - min;
    // Row 0 is the top; a flat series sits in the middle
    const rowOf = (value: number): number => (span > 0
        ? Math.min(BRAILLE_ROWS - 1, Math.max(0, Math.round((max - value) / span * (BRAILLE_ROWS - 1))))
        : Math.floor(BRAILLE_ROWS / 2));

    let glyphs = '';
    for (let cell = 0; cell < cells; cell++) {
        let bits = 0;
        for (let column = 0; column < 2; column++) {
            const index = cell * 2 + column;
            const value = samples[index];
            if (value === undefined) {
                continue;
            }

            const row = rowOf(value);
            const previous = samples[index - 1];
            const previousRow = previous === undefined ? row : rowOf(previous);
            // Fill from the previous sample's row to this one so the line connects
            for (let r = Math.min(row, previousRow); r <= Math.max(row, previousRow); r++) {
                bits |= BRAILLE_DOT_BITS[r]?.[column] ?? 0;
            }
        }

        glyphs += String.fromCharCode(0x2800 + bits);
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    const netChange = first !== undefined && last !== undefined && first !== 0
        ? (last - first) / first * 100
        : undefined;
    return colorizeTrend(glyphs, trendKeyForChange(netChange), settings, colorLevel);
}

/**
 * A candle chart in one row of text. A cell cannot hold a body and both wicks,
 * so each bar keeps the two things a glance is actually for: height places the
 * close inside the window's full high-low range, and color gives the bar's own
 * direction. The click-through report draws the real thing.
 */
export function candleline(bars: readonly Bar[], points: number, settings: Settings, colorLevel: ColorLevelString): string {
    const window = bars.slice(-points);
    if (window.length === 0) {
        return '';
    }

    // Scale to the candle bodies, not the wicks: one spike low would otherwise
    // squash every body into the same two glyph levels.
    const high = Math.max(...window.map(bar => Math.max(bar.o, bar.c)));
    const low = Math.min(...window.map(bar => Math.min(bar.o, bar.c)));
    const span = high - low;
    const midBlock = SPARKLINE_BLOCKS[Math.floor(SPARKLINE_BLOCKS.length / 2)] ?? '▄';

    return window
        .map((bar) => {
            const index = span > 0 ? Math.round((bar.c - low) / span * (SPARKLINE_BLOCKS.length - 1)) : -1;
            const glyph = (index >= 0 ? SPARKLINE_BLOCKS[index] : midBlock) ?? midBlock;
            return colorizeTrend(glyph, bar.c >= bar.o ? 'up' : 'down', settings, colorLevel);
        })
        .join('');
}

/** Local wall clock, `18:37` - when the thing happened, not how long ago. */
export function formatClock(timestamp: number): string {
    const when = new Date(timestamp);
    return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

/** Compact age, e.g. `40s`, `12m`, `2h`, `3d`. */
export function formatAge(ageMs: number): string {
    const seconds = Math.max(0, Math.floor(ageMs / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m`;
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)}h`;
    }
    return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Last `points` closes as block characters, scaled to the window's own low and
 * high so a 1% move still uses the full height. A flat series draws mid-height
 * rather than dividing by a zero range.
 */
export function sparkline(values: number[], points: number): string {
    const window = values.slice(-points);
    if (window.length === 0) {
        return '';
    }

    const min = Math.min(...window);
    const max = Math.max(...window);
    const span = max - min;
    const midBlock = SPARKLINE_BLOCKS[Math.floor(SPARKLINE_BLOCKS.length / 2)] ?? '▄';

    return window
        .map((value) => {
            if (span <= 0) {
                return midBlock;
            }
            const index = Math.round((value - min) / span * (SPARKLINE_BLOCKS.length - 1));
            return SPARKLINE_BLOCKS[index] ?? midBlock;
        })
        .join('');
}
