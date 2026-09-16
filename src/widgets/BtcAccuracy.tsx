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
import type { LedgerSummary } from '../utils/btc-ledger';
import {
    DEFAULT_HORIZON_ID,
    HORIZONS,
    hasDueScoring,
    readLedger,
    scheduleScoring,
    summarize
} from '../utils/btc-ledger';
import {
    ensureReportServer,
    getReportUrl
} from '../utils/btc-report';
import { renderOsc8Link } from '../utils/hyperlink';

import type { TrendColorKey } from './shared/crypto-display';
import {
    colorizeTrend,
    isTrendColorsEnabled,
    toggleTrendColors
} from './shared/crypto-display';
import {
    CryptoSymbolEditor,
    EDIT_SYMBOL_ACTION,
    SYMBOL_KEYBIND
} from './shared/crypto-editor';
import { isHidden } from './shared/hideable';

const LABEL = 'Hit: ';
const NO_DATA_HIDEABLE_STATE: HideableState = { key: 'no-data', label: 'until enough calls have been scored' };
const SAMPLE_CHOICES = [1, 6, 12, 24];
const DEFAULT_SAMPLE_HOURS = 6;
// How far the hit rate must sit from the always-same-answer baseline before
// calling it good or bad; inside this band it is noise.
const EDGE_BAND = 5;

function getHorizonId(item: WidgetItem): string {
    return HORIZONS.find(horizon => horizon.id === item.metadata?.horizon)?.id ?? DEFAULT_HORIZON_ID;
}

function getSampleHours(item: WidgetItem): number {
    const raw = Number(item.metadata?.sample);
    return SAMPLE_CHOICES.includes(raw) ? raw : DEFAULT_SAMPLE_HOURS;
}

function isBaselineShown(item: WidgetItem): boolean {
    return item.metadata?.baseline === 'true';
}

function cycle<T>(choices: readonly T[], current: T, fallback: T): T {
    return choices[(choices.indexOf(current) + 1) % choices.length] ?? fallback;
}

function withMetadata(item: WidgetItem, key: string, value: string): WidgetItem {
    return { ...item, metadata: { ...(item.metadata ?? {}), [key]: value } };
}

/** Green only when the calls beat repeating one verdict forever. */
function colorKeyFor(summary: LedgerSummary): TrendColorKey {
    if (summary.rate === null || summary.baselineRate === null) {
        return 'muted';
    }
    const edge = summary.rate - summary.baselineRate;
    if (edge > EDGE_BAND) {
        return 'up';
    }
    return edge < -EDGE_BAND ? 'down' : 'flat';
}

export class BtcAccuracyWidget implements Widget {
    getDefaultColor(): string { return 'white'; }
    getDescription(): string { return 'Shows how often the crypto advice was right, scored against what the price actually did'; }
    getDisplayName(): string { return 'Crypto Advice Accuracy'; }
    getCategory(): string { return 'Crypto'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        return {
            displayText: this.getDisplayName(),
            modifierText: `(${getWidgetSymbol(item)}, ${getHorizonId(item)}, 1 per ${getSampleHours(item)}h)`
        };
    }

    getHideableStates(): HideableState[] {
        return [NO_DATA_HIDEABLE_STATE];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        switch (action) {
            case 'cycle-horizon':
                return withMetadata(item, 'horizon', cycle(HORIZONS.map(horizon => horizon.id), getHorizonId(item), DEFAULT_HORIZON_ID));
            case 'cycle-sample':
                return withMetadata(item, 'sample', String(cycle(SAMPLE_CHOICES, getSampleHours(item), DEFAULT_SAMPLE_HOURS)));
            case 'toggle-baseline':
                return withMetadata(item, 'baseline', isBaselineShown(item) ? 'false' : 'true');
            case 'toggle-trend-colors':
                return toggleTrendColors(item);
            default:
                return null;
        }
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        const colorLevel = getColorLevelString(settings.colorLevel);
        const useColors = isTrendColorsEnabled(item);
        const label = item.rawValue ? '' : LABEL;
        const paint = (text: string, key: TrendColorKey): string => (useColors ? colorizeTrend(text, key, settings, colorLevel) : text);

        if (context.isPreview) {
            const preview = `${label}62% (13/21)${isBaselineShown(item) ? ' vs 48%' : ''}`;
            return paint(preview, 'up');
        }

        const symbol = getWidgetSymbol(item);
        const ledger = readLedger(symbol);
        if (hasDueScoring(ledger)) {
            scheduleScoring(symbol);   // settles in the background, lands next render
        }

        const summary = summarize(ledger, { horizonId: getHorizonId(item), sampleHours: getSampleHours(item) });
        const port = ensureReportServer();
        const link = (text: string): string => (port === null ? text : renderOsc8Link(getReportUrl(symbol, port), text));

        if (summary.rate === null || !summary.enoughData) {
            if (isHidden(item, NO_DATA_HIDEABLE_STATE.key)) {
                return null;
            }
            // Say how far off a first number is instead of showing a fake one
            return link(paint(`${label}${summary.n}/5`, 'muted'));
        }

        const parts = [`${Math.round(summary.rate)}% (${summary.hits}/${summary.n})`];
        if (isBaselineShown(item) && summary.baselineRate !== null) {
            parts.push(`vs ${Math.round(summary.baselineRate)}%`);
        }

        return link(paint(`${label}${parts.join(' ')}`, colorKeyFor(summary)));
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            SYMBOL_KEYBIND,
            { key: 'n', label: 'horizo(n) cycle', action: 'cycle-horizon' },
            { key: 'p', label: 'sam(p)le window cycle', action: 'cycle-sample' },
            { key: 'f', label: 'baseline compare (f)', action: 'toggle-baseline' },
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
