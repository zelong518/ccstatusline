import {
    Box,
    Text,
    useInput
} from 'ink';
import React, { useState } from 'react';

import type { WidgetEditorProps } from '../../types/Widget';
import { normalizeSymbol } from '../../utils/btc';

export const EDIT_SYMBOL_ACTION = 'edit-symbol';
export const SYMBOL_KEYBIND = { key: 'y', label: 's(y)mbol…', action: EDIT_SYMBOL_ACTION };

/**
 * Exchange pair input. Symbols are plain ASCII (BTCUSDT, ETHUSDT), so this
 * stays a simple line editor instead of the grapheme-aware one CustomText needs.
 */
export const CryptoSymbolEditor: React.FC<WidgetEditorProps> = ({ widget, onComplete, onCancel }) => {
    const [symbol, setSymbol] = useState(widget.metadata?.symbol ?? '');

    useInput((input, key) => {
        if (key.return) {
            onComplete({
                ...widget,
                metadata: { ...(widget.metadata ?? {}), symbol: normalizeSymbol(symbol) }
            });
        } else if (key.escape) {
            onCancel();
        } else if (key.backspace || key.delete) {
            setSymbol(symbol.slice(0, -1));
        } else if (!key.ctrl && !key.meta && /^[A-Za-z0-9]+$/.test(input)) {
            setSymbol((symbol + input).toUpperCase().slice(0, 20));
        }
    });

    return (
        <Box flexDirection='column'>
            <Text>
                {'Trading pair: '}
                {symbol}
                <Text inverse> </Text>
            </Text>
            <Text dimColor>Exchange pair, e.g. BTCUSDT / ETHUSDT / SOLUSDT. Enter save, ESC cancel</Text>
        </Box>
    );
};
