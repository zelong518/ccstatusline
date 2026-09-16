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
import type {
    BtcAdvice,
    BtcVerdict
} from '../utils/btc-advice';
import {
    getAdviceIntervalMinutes,
    getAdviceLanguage,
    getAdviceModel,
    getBtcAdvice,
    getVerdictLabel,
    isNewsEnabled
} from '../utils/btc-advice';
import {
    ensureReportServer,
    getReportUrl
} from '../utils/btc-report';
import { renderOsc8Link } from '../utils/hyperlink';

import type { TrendColorKey } from './shared/crypto-display';
import {
    colorizeTrend,
    formatAge,
    isTrendColorsEnabled,
    toggleTrendColors
} from './shared/crypto-display';
import {
    CryptoSymbolEditor,
    EDIT_SYMBOL_ACTION,
    SYMBOL_KEYBIND
} from './shared/crypto-editor';
import { isHidden } from './shared/hideable';

const LABEL = 'Advice: ';
const NO_DATA_HIDEABLE_STATE: HideableState = { key: 'no-data', label: 'until the first answer arrives' };
const INTERVAL_CHOICES = [15, 30, 60, 120, 360];
const REFRESH_GLYPH = '⟳';
const DETAIL_CHOICES = ['none', 'catalyst', 'reason'] as const;

type DetailMode = typeof DETAIL_CHOICES[number];

const VERDICT_COLOR_KEYS: Record<BtcVerdict, TrendColorKey> = {
    BUY: 'up',
    HOLD: 'flat',
    SELL: 'down'
};

function isConfidenceShown(item: WidgetItem): boolean {
    return item.metadata?.confidence !== 'false';
}

function isAgeShown(item: WidgetItem): boolean {
    return item.metadata?.age === 'true';
}

/** The verdict links to the local report; the glyph next to it re-asks now. */
function areLinksEnabled(item: WidgetItem): boolean {
    return item.metadata?.link !== 'false';
}

function getDetailMode(item: WidgetItem): DetailMode {
    const mode = item.metadata?.detail;
    return DETAIL_CHOICES.find(choice => choice === mode) ?? 'none';
}

function cycleFrom<T>(choices: readonly T[], current: T, fallback: T): T {
    const index = choices.indexOf(current);
    return choices[(index + 1) % choices.length] ?? fallback;
}

function withMetadata(item: WidgetItem, key: string, value: string): WidgetItem {
    return { ...item, metadata: { ...(item.metadata ?? {}), [key]: value } };
}

function getDetailText(advice: BtcAdvice, mode: DetailMode): string | undefined {
    if (mode === 'catalyst') {
        return advice.catalyst ?? advice.reason;
    }
    if (mode === 'reason') {
        return advice.reason ?? advice.catalyst;
    }
    return undefined;
}

export class BtcAdviceWidget implements Widget {
    getDefaultColor(): string { return 'magenta'; }
    getDescription(): string { return 'Asks Claude on a timer whether to buy, after it searches the news driving the move'; }
    getDisplayName(): string { return 'Crypto Advice'; }
    getCategory(): string { return 'Crypto'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers = [
            getWidgetSymbol(item),
            `every ${getAdviceIntervalMinutes(item)}m`,
            isNewsEnabled(item) ? 'news' : 'chart only'
        ];
        const detail = getDetailMode(item);
        if (detail !== 'none') {
            modifiers.push(detail);
        }
        if (!areLinksEnabled(item)) {
            modifiers.push('no report link');
        }
        return { displayText: this.getDisplayName(), modifierText: `(${modifiers.join(', ')})` };
    }

    getHideableStates(): HideableState[] {
        return [NO_DATA_HIDEABLE_STATE];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        switch (action) {
            case 'cycle-interval':
                return withMetadata(item, 'intervalMinutes', String(cycleFrom(INTERVAL_CHOICES, getAdviceIntervalMinutes(item), 30)));
            case 'toggle-confidence':
                return withMetadata(item, 'confidence', isConfidenceShown(item) ? 'false' : 'true');
            case 'toggle-age':
                return withMetadata(item, 'age', isAgeShown(item) ? 'false' : 'true');
            case 'cycle-detail':
                return withMetadata(item, 'detail', cycleFrom(DETAIL_CHOICES, getDetailMode(item), 'none'));
            case 'toggle-language':
                return withMetadata(item, 'lang', getAdviceLanguage(item) === 'zh' ? 'en' : 'zh');
            case 'toggle-news':
                return withMetadata(item, 'news', isNewsEnabled(item) ? 'false' : 'true');
            case 'toggle-links':
                return withMetadata(item, 'link', areLinksEnabled(item) ? 'false' : 'true');
            case 'toggle-trend-colors':
                return toggleTrendColors(item);
            default:
                return null;
        }
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const language = getAdviceLanguage(item);
        const colorLevel = getColorLevelString(settings.colorLevel);
        const useTrendColors = isTrendColorsEnabled(item);
        const label = item.rawValue ? '' : LABEL;
        const paint = (text: string, key: TrendColorKey): string => (useTrendColors ? colorizeTrend(text, key, settings, colorLevel) : text);

        if (context.isPreview) {
            const parts = [getVerdictLabel('HOLD', language)];
            if (isConfidenceShown(item)) {
                parts.push('65');
            }
            if (isAgeShown(item)) {
                parts.push('· 12m');
            }
            if (getDetailMode(item) !== 'none') {
                parts.push(language === 'zh' ? '· 等 CPI 数据' : '· waiting on CPI');
            }
            if (areLinksEnabled(item)) {
                parts.push(REFRESH_GLYPH);
            }
            return paint(`${label}${parts.join(' ')}`, 'flat');
        }

        const symbol = getWidgetSymbol(item);
        // Reading the cache also schedules the next ask when this one has aged out
        const advice = getBtcAdvice(item, context.btcData?.[symbol] !== undefined);

        // Starting the report server costs one render: the first call spawns it
        // and returns nothing, so the text simply goes out unlinked that once.
        const port = areLinksEnabled(item) ? ensureReportServer() : null;
        const link = (text: string, refresh: boolean): string => (port === null ? text : renderOsc8Link(getReportUrl(symbol, port, refresh), text));
        const withRefreshButton = (text: string): string => (port === null ? text : `${text} ${link(REFRESH_GLYPH, true)}`);

        if (!advice || (!advice.verdict && !advice.error)) {
            // First run: the detached ask is on its way but has nothing yet
            return isHidden(item, NO_DATA_HIDEABLE_STATE.key) ? null : paint(`${label}…`, 'muted');
        }

        if (!advice.verdict) {
            return isHidden(item, NO_DATA_HIDEABLE_STATE.key)
                ? null
                : withRefreshButton(link(paint(`${label}?`, 'muted'), false));
        }

        const parts = [getVerdictLabel(advice.verdict, language)];
        if (isConfidenceShown(item) && advice.confidence !== undefined) {
            parts.push(String(advice.confidence));
        }
        if (isAgeShown(item)) {
            parts.push(`· ${formatAge(Date.now() - advice.askedAt)}`);
        }
        const detail = getDetailText(advice, getDetailMode(item));
        if (detail) {
            parts.push(`· ${detail}`);
        }

        return withRefreshButton(link(paint(`${label}${parts.join(' ')}`, VERDICT_COLOR_KEYS[advice.verdict]), false));
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            SYMBOL_KEYBIND,
            { key: 'n', label: 'i(n)terval cycle', action: 'cycle-interval' },
            { key: 'f', label: 'con(f)idence toggle', action: 'toggle-confidence' },
            { key: 'g', label: 'a(g)e toggle', action: 'toggle-age' },
            { key: 'w', label: '(w)hy: reason/catalyst', action: 'cycle-detail' },
            { key: 'l', label: '(l)anguage toggle', action: 'toggle-language' },
            { key: 's', label: 'news (s)earch toggle', action: 'toggle-news' },
            { key: 'o', label: 'clickable rep(o)rt toggle', action: 'toggle-links' },
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

// Referenced so the model choice stays visible to the editor display in future
// revisions; kept out of the rendered line, which has no room for it.
export const getAdviceModelForItem = getAdviceModel;
