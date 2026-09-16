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
const POINT_CHOICES = [8, 12, 16, 24, 30, 48];
const DEFAULT_POINTS = 12;
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

function getPoints(item: WidgetItem): number {
    const raw = Number(item.metadata?.points);
    const requested = POINT_CHOICES.includes(raw) ? raw : DEFAULT_POINTS;
    // Daily bars are only kept 30 deep; asking for 48 of them would just pad
    return getInterval(item) === '1d' ? Math.min(requested, 30) : requested;
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
        const modifiers = [getWidgetSymbol(item), `${getPoints(item)}x${getInterval(item)}`, getStyle(item)];
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
                return withMetadata(item, 'points', String(cycle(POINT_CHOICES, getPoints(item), DEFAULT_POINTS)));
            case 'cycle-interval':
                return withMetadata(item, 'bar', cycle(INTERVALS, getInterval(item), '1h'));
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

        const draw = (bars: Bar[]): string => {
            const closes = barCloses(bars);
            if (style === 'braille') {
                return brailleline(closes, points, settings, colorLevel);
            }
            if (style === 'candles') {
                return candleline(bars, points, settings, colorLevel);
            }

            const line = sparkline(closes, points);
            if (!isTrendColorsEnabled(item)) {
                return line;
            }

            // Color the line by the move it actually covers, not the 24h ticker
            const window = closes.slice(-points);
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
            { key: 'p', label: '(p)oints cycle', action: 'cycle-points' },
            { key: 'b', label: '(b)ar interval 1h/1d', action: 'cycle-interval' },
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
