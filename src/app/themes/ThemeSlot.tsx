import React from 'react';
import type { ThemeSlotName } from '../../ui-themes.js';

/**
 * A named place for theme controls (ui-themes.js THEME_SLOTS). Empty and
 * `display: contents` (or, for a row, a flex line hidden while empty), so it takes no room and its parent lays out whatever
 * ThemeControls puts in it. React never renders children here, so it leaves
 * those alone.
 */
const ThemeSlot: React.FC<{ name: ThemeSlotName; row?: boolean }> = ({ name, row }) =>
  // A row slot is its own flex line (hidden while empty); the others are inline.
  row ? <div className="theme-slot-row" data-theme-slot={name} /> : <span className="theme-slot" data-theme-slot={name} />;

export default React.memo(ThemeSlot);
