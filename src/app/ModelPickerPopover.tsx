import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Loader2, Play, Search } from 'lucide-react';
import type { AgentModel, AgentProvider, AgentProviderId } from '../agentCatalog';
import { installFx, useFxInstall } from './fxInstall';

type ModelPickerPopoverProps = {
  /** Provider tabs on the left rail, in order. */
  providers: AgentProvider[];
  /** Every selectable model. Rows are narrowed by the active tab and the query. */
  models: AgentModel[];
  activeProviderId: AgentProviderId;
  onActiveProviderChange: (id: AgentProviderId) => void;
  search: string;
  onSearchChange: (query: string) => void;
  selectedModelId: string | null | undefined;
  onSelect: (model: AgentModel) => void;
  /**
   * Floating pill drawn over the search strip (the composer's Claude Code CLI
   * entry). The panel reserves room for it whenever it renders something.
   */
  overlay?: ReactNode;
  /** Which side of the trigger the popover unfolds on. Defaults to 'above'. */
  placement?: 'above' | 'below';
  /** Extra class on the popover, e.g. to widen or narrow a specific mount. */
  className?: string;
};

/**
 * The provider-rail model picker shared by the composer and Settings. Both
 * mounts drive it with their own tab/search/selection state so opening one
 * never disturbs the other.
 */
export const ModelPickerPopover = ({
  providers,
  models,
  activeProviderId,
  onActiveProviderChange,
  search,
  onSearchChange,
  selectedModelId,
  onSelect,
  overlay,
  placement = 'above',
  className,
}: ModelPickerPopoverProps) => {
  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return models.filter((model) => {
      if (model.providerId !== activeProviderId) return false;
      if (!query) return true;
      return (
        model.label.toLowerCase().includes(query) ||
        model.providerLabel.toLowerCase().includes(query) ||
        model.slug.toLowerCase().includes(query)
      );
    });
  }, [activeProviderId, models, search]);

  // fx is the one provider Durango Code can install itself: while its CLI is
  // missing, its tab offers the install and its rows install then select.
  const fxInstall = useFxInstall();
  const fxMissing =
    activeProviderId === 'fx' &&
    models.some((model) => model.providerId === 'fx') &&
    models.every((model) => model.providerId !== 'fx' || model.available === false);
  const installThenSelect = async (model?: AgentModel) => {
    if (await installFx()) {
      if (model) onSelect(model);
    }
  };

  // Keep the selected row in view when the popover opens on a long list. This
  // scrolls the list box by hand rather than with scrollIntoView, which walks
  // up to every scrollable ancestor and yanks the whole Settings pane.
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = selectedRowRef.current;
    if (!list || !row) return;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop;
    else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight;
    }
    // Only on mount / tab change: scrolling on every keystroke fights the user.
  }, [activeProviderId]);

  // A popover that unfolds downward hangs off a scrolling pane (Settings), so
  // it can run past the window. Flip it above the trigger when the room is
  // there — the page itself must never scroll just because a menu opened.
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [flipped, setFlipped] = useState(false);
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (placement !== 'below' || !popover) return;
    const anchor = popover.parentElement?.getBoundingClientRect();
    const rect = popover.getBoundingClientRect();
    const overflowsBelow = rect.bottom > window.innerHeight - 8;
    const roomAbove = (anchor?.top ?? 0) - 8;
    setFlipped(overflowsBelow && roomAbove >= rect.height);
  }, [placement]);

  // The panel is several times wider than its trigger, so where the trigger
  // sits inside a narrow, clipping box — the composer of a split pane, which
  // hides its overflow — CSS placement either runs off the window or is cut off
  // at the pane edge. In that case only, pin the panel to the window instead:
  // `fixed` escapes the pane's clip, and the offsets keep it beside its trigger.
  // A picker that already fits (full-width composer, Settings) is left exactly
  // as its CSS placed it, inline styles and all untouched.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const anchor = popover?.parentElement;
    if (!popover || !anchor) return undefined;

    // Overflow policy is stable for one open session. Cache it so scroll and
    // resize corrections only re-read geometry, not every ancestor's styles.
    const clippingAncestors: Array<{
      node: HTMLElement;
      clipsX: boolean;
      clipsY: boolean;
    }> = [];
    for (let node: HTMLElement | null = anchor; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      const clipsX = style.overflowX !== 'visible';
      const clipsY = style.overflowY !== 'visible';
      if (clipsX || clipsY) clippingAncestors.push({ node, clipsX, clipsY });
    }

    const fit = () => {
      // Always measure the CSS placement, never a corrected one: a window
      // resized back to roomy then drops the correction instead of drifting.
      popover.style.position = '';
      popover.style.left = '';
      popover.style.right = '';
      popover.style.top = '';
      popover.style.bottom = '';
      popover.style.width = '';
      popover.style.minWidth = '';
      popover.style.height = '';

      const margin = 12;
      // offsetWidth/offsetLeft, not the bounding rect: the open animation
      // scales the box, so a rect read mid-animation measures short.
      const width = popover.offsetWidth;
      const height = popover.offsetHeight;
      const anchorRect = anchor.getBoundingClientRect();
      const naturalLeft = anchorRect.left + popover.offsetLeft;
      const naturalTop = anchorRect.top + popover.offsetTop;

      // How much horizontal room the panel actually has where it is: the window
      // narrowed by every ancestor that hides its overflow.
      let clipLeft = 0;
      let clipRight = window.innerWidth;
      let clipTop = 0;
      let clipBottom = window.innerHeight;
      for (const { node, clipsX, clipsY } of clippingAncestors) {
        const rect = node.getBoundingClientRect();
        if (clipsX) {
          clipLeft = Math.max(clipLeft, rect.left);
          clipRight = Math.min(clipRight, rect.right);
        }
        if (clipsY) {
          clipTop = Math.max(clipTop, rect.top);
          clipBottom = Math.min(clipBottom, rect.bottom);
        }
      }

      if (
        naturalLeft >= clipLeft - 0.5 &&
        naturalLeft + width <= clipRight + 0.5 &&
        naturalTop >= clipTop - 0.5 &&
        naturalTop + height <= clipBottom + 0.5
      ) {
        return;
      }

      const cappedWidth = Math.min(width, window.innerWidth - margin * 2);
      const cappedHeight = Math.min(height, window.innerHeight - margin * 2);
      const left = Math.min(
        Math.max(naturalLeft, margin),
        Math.max(margin, window.innerWidth - margin - cappedWidth)
      );
      const top = Math.min(
        Math.max(naturalTop, margin),
        Math.max(margin, window.innerHeight - margin - cappedHeight)
      );

      popover.style.position = 'fixed';
      popover.style.left = `${Math.round(left)}px`;
      popover.style.top = `${Math.round(top)}px`;
      popover.style.right = 'auto';
      popover.style.bottom = 'auto';
      if (cappedWidth < width) {
        popover.style.width = `${cappedWidth}px`;
        // The CSS min-width would otherwise outrank the cap.
        popover.style.minWidth = `${cappedWidth}px`;
      }
      if (cappedHeight < height) popover.style.height = `${cappedHeight}px`;
    };

    // Coalesce resize, scroll, observer, and mutation bursts into one pass.
    // Deferring observer-triggered writes also keeps them outside the current
    // ResizeObserver delivery and avoids loop churn.
    let fitFrame: number | null = null;
    const scheduleFit = () => {
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        fit();
      });
    };
    const handleScroll = (event: Event) => {
      const target = event.target;
      // Ignore scrolling inside the picker itself. Only a scrolling ancestor
      // of the anchor can move its natural placement.
      if (
        target === window ||
        target === document ||
        (target instanceof Element && target.contains(anchor))
      ) {
        scheduleFit();
      }
    };

    // The first pass is synchronous so the picker is corrected before paint.
    fit();
    window.addEventListener('resize', scheduleFit);
    // Scroll events do not bubble, so capture them at the window to follow
    // anchors inside Settings and any other scrolling pane.
    window.addEventListener('scroll', handleScroll, true);
    // Split-grid changes move the trigger by resizing one of its ancestors.
    // The anchor and clipping boxes are the geometry that can affect fitting.
    const resizeObserver = new ResizeObserver(scheduleFit);
    const observedNodes = new Set<HTMLElement>([
      anchor,
      ...clippingAncestors.map(({ node }) => node),
    ]);
    const splitGrid = anchor.closest('.thread-panes');
    if (splitGrid instanceof HTMLElement) observedNodes.add(splitGrid);
    for (const node of observedNodes) resizeObserver.observe(node);
    const mutationObserver = splitGrid ? new MutationObserver(scheduleFit) : null;
    if (splitGrid && mutationObserver) {
      mutationObserver.observe(splitGrid, { attributes: true, childList: true });
    }
    return () => {
      window.removeEventListener('resize', scheduleFit);
      window.removeEventListener('scroll', handleScroll, true);
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
    };
  }, [flipped, placement]);

  return (
    <div
      ref={popoverRef}
      className={`model-picker-popover${placement === 'below' ? ' below' : ''}${
        flipped ? ' flip-up' : ''
      }${className ? ` ${className}` : ''}`}
    >
      <div className="model-provider-rail">
        {providers.map((provider) => {
          const Icon = provider.icon;
          return (
            <button
              key={provider.id}
              className={`provider-rail-button ${activeProviderId === provider.id ? 'active' : ''}`}
              onClick={() => onActiveProviderChange(provider.id)}
              title={provider.label}
            >
              <Icon size={19} />
            </button>
          );
        })}
      </div>
      <div className={`model-picker-panel${overlay ? ' has-cli-overlay' : ''}`}>
        {overlay}
        <div className="model-search">
          <Search size={16} />
          <input
            autoFocus
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search models..."
          />
        </div>
        <div className="model-list" ref={listRef}>
          {fxMissing && (
            <div className="mx-1 mb-1.5 mt-1 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-[var(--text-primary,#e5e5e5)]">
                  {fxInstall.installing ? 'Installing fx…' : 'fx isn’t installed'}
                </span>
                <span className="text-xs leading-snug text-[var(--text-secondary,#a3a3a3)]">
                  {fxInstall.error
                    ? `Install failed: ${fxInstall.error}`
                    : 'Install it to run these models on your ChatGPT or Grok subscription, or on Durango credits.'}
                </span>
              </span>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-white/90 px-2.5 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-white disabled:cursor-default disabled:opacity-60"
                disabled={fxInstall.installing}
                onClick={() => void installThenSelect()}
              >
                {fxInstall.installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                {fxInstall.installing ? 'Installing' : fxInstall.error ? 'Try again' : 'Install fx'}
              </button>
            </div>
          )}
          {visibleModels.map((model) => {
            const ProviderIcon =
              providers.find((provider) => provider.id === model.providerId)?.icon ?? Play;
            const selected = selectedModelId === model.id;
            const installable = fxMissing && model.providerId === 'fx';
            return (
              <button
                key={model.id}
                ref={selected ? selectedRowRef : undefined}
                className={`model-row ${selected ? 'selected' : ''}`}
                onClick={() => (installable ? void installThenSelect(model) : onSelect(model))}
                disabled={installable ? fxInstall.installing : model.available === false}
                title={installable ? 'Install fx and use this model' : model.unavailableReason ?? model.slug}
              >
                <ProviderIcon size={18} />
                <span className="model-row-text">
                  <span className="model-row-label">{model.label}</span>
                  <span className="model-row-provider">{model.providerLabel}</span>
                </span>
                {model.shortcut && <span className="model-shortcut">{model.shortcut}</span>}
                {selected && <Check size={15} />}
              </button>
            );
          })}
          {visibleModels.length === 0 && <div className="model-empty">No models</div>}
        </div>
      </div>
    </div>
  );
};
