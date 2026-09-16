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

    const high = Math.max(...window.map(bar => bar.h));
    const low = Math.min(...window.map(bar => bar.l));
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
 * Last `points` closes as block characters. A flat series draws mid-height
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
