import React from 'react';

import { getColorLevelString } from '../types/ColorLevel';
import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    HideableState,
    Widget,
    WidgetEditorDisplay,
    WidgetEditorProps,
    WidgetItem
} from '../types/Widget';
import type { Bar } from '../utils/btc';
import {
    barCloses,
    getWidgetSymbol
} from '../utils/btc';

import {
    aggregateBars,
    brailleline,
    candleline,
    colorizeTrend,
    isTrendColorsEnabled,
    sparkline,
    toggleTrendColors,
    trendKeyForChange
} from './shared/crypto-display';
import {
    CryptoSymbolEditor,
    EDIT_SYMBOL_ACTION,
    SYMBOL_KEYBIND
} from './shared/crypto-editor';
import { isHidden } from './shared/hideable';

const NO_DATA_HIDEABLE_STATE: HideableState = { key: 'no-data', label: 'when the quote is unavailable' };
// `points` always means bars of history - the time span - whatever the style
// draws with. Braille packs two bars per cell, so 48 hourly bars is 24 cells
// wide; candles and the sparkline are one cell per bar.
const HOURLY_POINT_CHOICES = [12, 24, 48, 72];
const DAILY_POINT_CHOICES = [7, 14, 30, 60];
const DEFAULT_POINTS = 24;
const WIDTH_CHOICES = [0, 8, 12, 16, 24];   // 0 = one cell per bar

const INTERVALS = ['1h', '1d'] as const;
const STYLES = ['braille', 'candles', 'line'] as const;

type Interval = typeof INTERVALS[number];
type TrendStyle = typeof STYLES[number];

function getInterval(item: WidgetItem): Interval {
    return item.metadata?.bar === '1d' ? '1d' : '1h';
}

/** Braille is the default: at a couple of percent of movement it is the only
 *  one of the three whose shape is actually readable. */
function getStyle(item: WidgetItem): TrendStyle {
    const style = item.metadata?.style;
    return STYLES.find(choice => choice === style) ?? 'braille';
}

function getPointChoices(item: WidgetItem): number[] {
    return getInterval(item) === '1d' ? DAILY_POINT_CHOICES : HOURLY_POINT_CHOICES;
}

function getPoints(item: WidgetItem): number {
    const choices = getPointChoices(item);
    const raw = Number(item.metadata?.points);
    if (choices.includes(raw)) {
        return raw;
    }
    // A span carried over from the other interval: clamp into this one's range
    const fallback = Number.isFinite(raw) ? raw : DEFAULT_POINTS;
    return Math.min(choices[choices.length - 1] ?? DEFAULT_POINTS, Math.max(choices[0] ?? DEFAULT_POINTS, Math.round(fallback)));
}

/** Cells to draw in. 0 means one per bar, i.e. no aggregation. */
function getWidth(item: WidgetItem): number {
    const raw = Number(item.metadata?.width);
    return WIDTH_CHOICES.includes(raw) ? raw : 12;
}

/** e.g. `48h`, `30d` - the span the chart covers. */
function getSpanLabel(item: WidgetItem): string {
    return `${getPoints(item)}${getInterval(item) === '1d' ? 'd' : 'h'}`;
}

function cycle<T>(choices: readonly T[], current: T, fallback: T): T {
    return choices[(choices.indexOf(current) + 1) % choices.length] ?? fallback;
}

function withMetadata(item: WidgetItem, key: string, value: string): WidgetItem {
    return { ...item, metadata: { ...(item.metadata ?? {}), [key]: value } };
}

function getBars(item: WidgetItem, context: RenderContext): Bar[] | null {
    const market = context.btcData?.[getWidgetSymbol(item)];
    if (!market) {
        return null;
    }
    const bars = getInterval(item) === '1d' ? market.dailyBars : market.hourlyBars;
    return bars.length > 0 ? bars : null;
}

const PREVIEW_BARS: Bar[] = [3, 5, 4, 6, 8, 7, 9, 12, 11, 14, 13, 16].map((close, index, all) => ({
    t: index,
    o: all[index - 1] ?? close,
    h: close + 1,
    l: (all[index - 1] ?? close) - 1,
    c: close
}));

export class BtcTrendWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Shows a braille line, candle or sparkline chart of recent price action'; }
    getDisplayName(): string { return 'Crypto Chart'; }
    getCategory(): string { return 'Crypto'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const width = getWidth(item);
        const modifiers = [getWidgetSymbol(item), getSpanLabel(item), getStyle(item), width === 0 ? 'per bar' : `${width} cells`];
        if (getStyle(item) === 'line' && isTrendColorsEnabled(item)) {
            modifiers.push('trend colors');
        }
        return { displayText: this.getDisplayName(), modifierText: `(${modifiers.join(', ')})` };
    }

    getHideableStates(): HideableState[] {
        return [NO_DATA_HIDEABLE_STATE];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        switch (action) {
            case 'cycle-points':
                return withMetadata(item, 'points', String(cycle(getPointChoices(item), getPoints(item), DEFAULT_POINTS)));
            case 'cycle-interval':
                return withMetadata(item, 'bar', cycle(INTERVALS, getInterval(item), '1h'));
            case 'cycle-width':
                return withMetadata(item, 'width', String(cycle(WIDTH_CHOICES, getWidth(item), 12)));
            case 'cycle-style':
                return withMetadata(item, 'style', cycle(STYLES, getStyle(item), 'braille'));
            case 'toggle-trend-colors':
                return toggleTrendColors(item);
            default:
                return null;
        }
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const colorLevel = getColorLevelString(settings.colorLevel);
        const points = getPoints(item);
        const style = getStyle(item);

        const width = getWidth(item);
        const draw = (allBars: Bar[]): string => {
            const span = allBars.slice(-points);
            // width 0 keeps one cell per bar; otherwise zoom out into `width`
            // longer bars, whose shape carries the trend instead of the noise
            const cells = width === 0 ? span.length : Math.min(width, span.length);
            const bars = aggregateBars(span, cells);
            const closes = barCloses(bars);

            if (style === 'braille') {
                return brailleline(barCloses(aggregateBars(span, cells * 2)), cells, settings, colorLevel);
            }
            if (style === 'candles') {
                return candleline(bars, cells, settings, colorLevel);
            }

            const line = sparkline(closes, cells);
            if (!isTrendColorsEnabled(item)) {
                return line;
            }

            // Color the line by the move it actually covers, not the 24h ticker
            const window = closes.slice(-cells);
            const first = window[0];
            const last = window[window.length - 1];
            const change = first !== undefined && last !== undefined && first !== 0
                ? (last - first) / first * 100
                : undefined;
            return colorizeTrend(line, trendKeyForChange(change), settings, colorLevel);
        };

        if (context.isPreview) {
            return draw(PREVIEW_BARS);
        }

        const bars = getBars(item, context);
        if (!bars) {
            return isHidden(item, NO_DATA_HIDEABLE_STATE.key) ? null : '?';
        }
        return draw(bars);
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            SYMBOL_KEYBIND,
            { key: 'p', label: 's(p)an cycle', action: 'cycle-points' },
            { key: 'b', label: '(b)ar interval 1h/1d', action: 'cycle-interval' },
            { key: 'w', label: '(w)idth cycle', action: 'cycle-width' },
            { key: 'v', label: 'style: candles/line (v)', action: 'cycle-style' },
            { key: 't', label: '(t)rend colors toggle', action: 'toggle-trend-colors' }
        ];
    }

    renderEditor(props: WidgetEditorProps): React.ReactElement | null {
        return props.action === EDIT_SYMBOL_ACTION ? <CryptoSymbolEditor {...props} /> : null;
    }

    // Braille and candles carry a color per cell; the plain line only when
    // trend colors are switched on
    preservesRenderedColors(item: WidgetItem): boolean {
        return getStyle(item) !== 'line' || isTrendColorsEnabled(item);
    }

    supportsRawValue(): boolean { return false; }
    supportsColors(item: WidgetItem): boolean { return !this.preservesRenderedColors(item); }
}
