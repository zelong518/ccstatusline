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
import { getWidgetSymbol } from '../utils/btc';

import {
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
const POINTS_METADATA_KEY = 'points';
const POINT_CHOICES = [8, 12, 16, 24, 48];
const DEFAULT_POINTS = 12;

function getPoints(item: WidgetItem): number {
    const raw = Number(item.metadata?.[POINTS_METADATA_KEY]);
    return POINT_CHOICES.includes(raw) ? raw : DEFAULT_POINTS;
}

function cyclePoints(item: WidgetItem): WidgetItem {
    const next = POINT_CHOICES[(POINT_CHOICES.indexOf(getPoints(item)) + 1) % POINT_CHOICES.length] ?? DEFAULT_POINTS;
    return {
        ...item,
        metadata: { ...(item.metadata ?? {}), [POINTS_METADATA_KEY]: String(next) }
    };
}

export class BtcTrendWidget implements Widget {
    getDefaultColor(): string { return 'cyan'; }
    getDescription(): string { return 'Shows an hourly price sparkline for a crypto pair'; }
    getDisplayName(): string { return 'Crypto Trend'; }
    getCategory(): string { return 'Crypto'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: `(${getWidgetSymbol(item)}, ${getPoints(item)}h${isTrendColorsEnabled(item) ? ', trend colors' : ''})`
        };
    }

    getHideableStates(): HideableState[] {
        return [NO_DATA_HIDEABLE_STATE];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === 'cycle-points') {
            return cyclePoints(item);
        }

        if (action === 'toggle-trend-colors') {
            return toggleTrendColors(item);
        }

        return null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const colorLevel = getColorLevelString(settings.colorLevel);
        const useTrendColors = isTrendColorsEnabled(item);

        if (context.isPreview) {
            const shape = [3, 5, 4, 6, 8, 7, 9, 12, 11, 14, 13, 16];
            const preview = sparkline(shape, getPoints(item));
            return useTrendColors ? colorizeTrend(preview, 'up', settings, colorLevel) : preview;
        }

        const market = context.btcData?.[getWidgetSymbol(item)];
        if (!market || market.hourlyCloses.length === 0) {
            return isHidden(item, NO_DATA_HIDEABLE_STATE.key) ? null : '?';
        }

        const points = getPoints(item);
        const bars = sparkline(market.hourlyCloses, points);

        // Color by the move the sparkline itself covers, not the 24h ticker
        const window = market.hourlyCloses.slice(-points);
        const first = window[0];
        const last = window[window.length - 1];
        const windowChange = first !== undefined && last !== undefined && first !== 0
            ? (last - first) / first * 100
            : undefined;

        return useTrendColors ? colorizeTrend(bars, trendKeyForChange(windowChange), settings, colorLevel) : bars;
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            SYMBOL_KEYBIND,
            { key: 'p', label: '(p)oints cycle', action: 'cycle-points' },
            { key: 't', label: '(t)rend colors toggle', action: 'toggle-trend-colors' }
        ];
    }

    renderEditor(props: WidgetEditorProps): React.ReactElement | null {
        return props.action === EDIT_SYMBOL_ACTION ? <CryptoSymbolEditor {...props} /> : null;
    }

    preservesRenderedColors(item: WidgetItem): boolean {
        return isTrendColorsEnabled(item);
    }

    supportsRawValue(): boolean { return false; }
    supportsColors(item: WidgetItem): boolean { return !isTrendColorsEnabled(item); }
}
