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
import {
    getSymbolBase,
    getWidgetSymbol
} from '../utils/btc';

import {
    colorizeTrend,
    formatPrice,
    formatSignedPercent,
    isTrendColorsEnabled,
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
const SHOW_CHANGE_METADATA_KEY = 'change';

function isChangeShown(item: WidgetItem): boolean {
    return item.metadata?.[SHOW_CHANGE_METADATA_KEY] !== 'false';
}

/** `$` only for dollar-quoted pairs; BTC-quoted pairs get no currency mark. */
function getPricePrefix(symbol: string): string {
    return /USDT?$|USDC$/.test(symbol) ? '$' : '';
}

export class BtcPriceWidget implements Widget {
    getDefaultColor(): string { return 'yellow'; }
    getDescription(): string { return 'Shows a crypto spot price with its 24h change (Binance, OKX fallback)'; }
    getDisplayName(): string { return 'Crypto Price'; }
    getCategory(): string { return 'Crypto'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers = [getWidgetSymbol(item)];
        if (!isChangeShown(item)) {
            modifiers.push('no change');
        }
        if (isTrendColorsEnabled(item)) {
            modifiers.push('trend colors');
        }
        return { displayText: this.getDisplayName(), modifierText: `(${modifiers.join(', ')})` };
    }

    getHideableStates(): HideableState[] {
        return [NO_DATA_HIDEABLE_STATE];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === 'toggle-change') {
            return {
                ...item,
                metadata: {
                    ...(item.metadata ?? {}),
                    [SHOW_CHANGE_METADATA_KEY]: isChangeShown(item) ? 'false' : 'true'
                }
            };
        }

        if (action === 'toggle-trend-colors') {
            return toggleTrendColors(item);
        }

        return null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const symbol = getWidgetSymbol(item);
        const label = item.rawValue ? '' : `${getSymbolBase(symbol)} `;
        const colorLevel = getColorLevelString(settings.colorLevel);
        const useTrendColors = isTrendColorsEnabled(item);

        if (context.isPreview) {
            const preview = `${label}${getPricePrefix(symbol)}${formatPrice(67432.18)}${isChangeShown(item) ? ` ${formatSignedPercent(1.24)}` : ''}`;
            return useTrendColors ? colorizeTrend(preview, 'up', settings, colorLevel) : preview;
        }

        const market = context.btcData?.[symbol];
        if (!market) {
            // The quote failed or has not landed yet; say so instead of lying
            return isHidden(item, NO_DATA_HIDEABLE_STATE.key) ? null : `${label}?`;
        }

        const price = `${getPricePrefix(symbol)}${formatPrice(market.price)}`;
        const text = isChangeShown(item)
            ? `${label}${price} ${formatSignedPercent(market.change24h)}`
            : `${label}${price}`;

        return useTrendColors
            ? colorizeTrend(text, trendKeyForChange(market.change24h), settings, colorLevel)
            : text;
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            SYMBOL_KEYBIND,
            { key: 'g', label: '24h chan(g)e toggle', action: 'toggle-change' },
            { key: 't', label: '(t)rend colors toggle', action: 'toggle-trend-colors' }
        ];
    }

    renderEditor(props: WidgetEditorProps): React.ReactElement | null {
        return props.action === EDIT_SYMBOL_ACTION ? <CryptoSymbolEditor {...props} /> : null;
    }

    preservesRenderedColors(item: WidgetItem): boolean {
        return isTrendColorsEnabled(item);
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return !isTrendColorsEnabled(item); }
}
