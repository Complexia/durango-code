import React, { useEffect, useState } from 'react';
import { Check, Copy, Download, ExternalLink, FileUp, Globe, Link2, Loader2, Share2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { themeShareFingerprint, type UiTheme } from '../../ui-themes.js';
import { runThemeAction } from './themeState';

/**
 * Community themes (durango.sh/code/themes, src/main/theme-community.js):
 * the Share dialog for one of the user's themes, the install dialog (opened by
 * a theme page's Install button through orion://theme/install, or a pasted
 * link), and the Community section of Settings → Themes. The gallery itself
 * is a web page; nothing here lists themes.
 */

type InstallState = { slug: string | null; open: (slugOrUrl: string) => void; close: () => void };

const useInstallDialog = create<InstallState>((set) => ({
  slug: null,
  open: (slugOrUrl) => set({ slug: slugOrUrl.trim() || null }),
  close: () => set({ slug: null }),
}));

export const openCommunityInstall = (slugOrUrl: string) => useInstallDialog.getState().open(slugOrUrl);

const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

const useEscape = (onClose: () => void) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
};

const Switch: React.FC<{ checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }> = ({
  checked,
  disabled,
  onChange,
  label,
}) => (
  <label className="provider-toggle" title={label}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span />
  </label>
);

const linkFor = (theme: UiTheme, url?: string | null) =>
  url ?? (theme.published ? `https://durango.sh/code/themes/${theme.published.slug}` : '');

/** Share one of the user's themes, or manage its shared copy. */
export const ShareThemeDialog: React.FC<{ theme: UiTheme; onClose: () => void }> = ({ theme, onClose }) => {
  const published = theme.published ?? null;
  const [listed, setListed] = useState(published?.listed ?? false);
  const [busy, setBusy] = useState<null | 'share' | 'listed' | 'unshare'>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEscape(onClose);
  // Compares content, so a rename counts too (it is not a new revision).
  const changedSinceShared = Boolean(
    published &&
      (published.fingerprint ? published.fingerprint !== themeShareFingerprint(theme) : (published.revision ?? 0) !== theme.revision)
  );
  const link = linkFor(theme, url);

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const share = async () => {
    const api = window.orion?.themes;
    if (!api?.share) return;
    setBusy('share');
    const result = await api.share(theme.id, { listed });
    setBusy(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setUrl(result.value.shared.url);
    copy(result.value.shared.url);
    toast.success(published ? `Updated the shared “${theme.name}”` : `Shared “${theme.name}”: link copied`);
  };

  const changeListed = async (value: boolean) => {
    setListed(value);
    if (!published) return;
    setBusy('listed');
    const error = await runThemeAction((api) => api.setShareListed!(theme.id, value));
    setBusy(null);
    if (error) {
      setListed(!value);
      toast.error(error);
    }
  };

  const unshare = async () => {
    setBusy('unshare');
    const error = await runThemeAction((api) => api.unshare!(theme.id));
    setBusy(null);
    if (error) toast.error(error);
    else {
      toast.success(`“${theme.name}” is no longer shared`);
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-theme-title"
        data-testid="share-theme-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="share-theme-title" className="modal-title">
          {published ? `“${theme.name}” is shared` : `Share “${theme.name}”`}
        </h2>
        <p className="modal-subtitle">
          {published
            ? 'Anyone with the link can install it in Durango Code. Copies people installed stay theirs if you stop sharing.'
            : 'Uploads the theme and its pictures or video to durango.sh and gives you a link. Anyone with the link can install it in Durango Code.'}
        </p>
        {link && (
          <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2">
            <Link2 size={13} className="shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-primary)]">{link}</span>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              onClick={() => copy(link)}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--border-default)] px-3 py-2.5">
          <div>
            <div className="text-[13px] font-medium text-[var(--text-primary)]">List in the community gallery</div>
            <div className="text-[12px] text-[var(--text-muted)]">
              Off: only people with the link see it. On: anyone browsing durango.sh/code/themes.
            </div>
          </div>
          <Switch checked={listed} disabled={busy !== null} onChange={(value) => void changeListed(value)} label="List in the community gallery" />
        </div>
        {published && (
          <p className="mt-2 text-[12px] text-[var(--text-muted)]">
            {changedSinceShared
              ? 'You changed this theme since you shared it. Update to share the new version.'
              : `Version ${published.version} is shared and matches this theme.`}
          </p>
        )}
        <div className="modal-actions">
          {published && (
            <button type="button" className="btn secondary mr-auto" disabled={busy !== null} onClick={() => void unshare()}>
              {busy === 'unshare' ? 'Stopping…' : 'Stop sharing'}
            </button>
          )}
          {published && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => void window.orion?.themes?.openGallery?.(published.slug)}
            >
              <ExternalLink size={13} /> Open page
            </button>
          )}
          {(!published || changedSinceShared) ? (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void share()} autoFocus>
              {busy === 'share' ? <Loader2 size={13} className="animate-spin" /> : <Share2 size={13} />}{' '}
              {busy === 'share' ? 'Uploading…' : published ? 'Update shared theme' : 'Share'}
            </button>
          ) : (
            <button type="button" className="btn" onClick={onClose} autoFocus>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

type PreviewResult = Awaited<ReturnType<NonNullable<NonNullable<Window['orion']['themes']>['previewCommunity']>>>;
type Preview = Extract<PreviewResult, { ok: true }>['value'];

/**
 * Asks before installing a community theme. Opened by orion://theme/install
 * links (main.js keeps one that arrives before this mounts) and by
 * openCommunityInstall. Mounted once, next to ThemeLayer.
 */
export const CommunityInstallDialog: React.FC = () => {
  const slug = useInstallDialog((state) => state.slug);
  const close = useInstallDialog((state) => state.close);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  // A T3 Code theme with light and dark versions: which one to import.
  const [look, setLook] = useState<'dark' | 'light' | null>(null);

  useEffect(() => {
    const api = window.orion?.themes;
    if (!api?.onInstallRequest) return undefined;
    void api.takeInstallRequest?.().then((result) => {
      if (result.ok && result.value) openCommunityInstall(result.value);
    });
    return api.onInstallRequest((next) => {
      void api.takeInstallRequest?.();
      openCommunityInstall(next);
    });
  }, []);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setLook(null);
    if (!slug) return undefined;
    let cancelled = false;
    void window.orion?.themes?.previewCommunity?.(slug).then((result) => {
      if (cancelled) return;
      if (result.ok) setPreview(result.value);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!slug) return null;

  const install = async () => {
    const api = window.orion?.themes;
    if (!api?.installCommunity) return;
    setInstalling(true);
    const result = await api.installCommunity(slug, look ? { appearance: look } : undefined);
    setInstalling(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(
      result.value.alreadyInstalled
        ? `Applied “${result.value.theme.name}” (you already had it)`
        : `${preview?.kind === 't3' ? 'Imported' : 'Installed'} “${result.value.theme.name}”. It's in Settings → Themes.`
    );
    close();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={close}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-theme-title"
        data-testid="install-theme-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        {error ? (
          <>
            <h2 id="install-theme-title" className="modal-title">
              Couldn't open that theme
            </h2>
            <p className="modal-subtitle">{error}</p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={close} autoFocus>
                OK
              </button>
            </div>
          </>
        ) : !preview ? (
          <div className="flex items-center gap-2 py-6 text-[13px] text-[var(--text-secondary)]">
            <Loader2 size={14} className="animate-spin" /> Loading the theme…
          </div>
        ) : (
          <>
            {preview.previewUrl && (
              <img
                alt=""
                src={preview.previewUrl}
                className="mb-3 aspect-[16/9] w-full rounded-[var(--radius-md)] border border-[var(--border-default)] object-cover"
              />
            )}
            <h2 id="install-theme-title" className="modal-title">
              {preview.kind === 't3' ? `Import “${preview.name}” from T3 Code?` : `Install “${preview.name}”?`}
            </h2>
            <p className="modal-subtitle">
              {preview.kind === 't3' ? (
                <>
                  A T3 Code theme · {preview.appearance}
                  {preview.animated ? ' · animated' : ''}
                </>
              ) : (
                <>
                  {preview.author ? `A community theme by ${preview.author}` : 'A community theme'} ·{' '}
                  {preview.installs} install{preview.installs === 1 ? '' : 's'}
                  {preview.bytes > 0 ? ` · ${formatBytes(preview.bytes)} download` : ''}
                  {preview.animated ? ' · animated' : ''}
                </>
              )}
            </p>
            {preview.description && <p className="mt-2 text-[13px] text-[var(--text-secondary)]">{preview.description}</p>}
            {preview.kind === 't3' && (preview.appearances?.length ?? 0) > 1 && (
              <div className="mt-3 flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
                <span>Import the</span>
                <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--border-default)] p-0.5" role="radiogroup" aria-label="Appearance">
                  {preview.appearances!.map((option) => {
                    const chosen = (look ?? preview.appearances![0]) === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={chosen}
                        onClick={() => setLook(option)}
                        className={`rounded-[calc(var(--radius-md)-2px)] px-2.5 py-1 capitalize transition ${chosen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'hover:text-[var(--text-primary)]'}`}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
                <span>version</span>
              </div>
            )}
            <p className="mt-3 text-[12px] text-[var(--text-muted)]">
              It's saved in Settings → Themes and applied now. Themes can't reach the network or your files, and
              {/Mac/i.test(navigator.platform) ? ' ⌘⌥⇧0' : ' Ctrl+Alt+Shift+0'} always returns to the original look.
              {preview.installedId ? ' You already have a copy of this theme; this adds the latest version.' : ''}
            </p>
            <div className="modal-actions">
              {preview.url && preview.slug && (
                <button
                  type="button"
                  className="btn secondary mr-auto"
                  onClick={() => void window.orion?.themes?.openGallery?.(preview.slug ?? undefined)}
                >
                  <ExternalLink size={13} /> View page
                </button>
              )}
              <button type="button" className="btn secondary" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={installing} onClick={() => void install()} autoFocus>
                {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}{' '}
                {installing ? 'Installing…' : preview.kind === 't3' ? 'Import and apply' : 'Install and apply'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const importT3File = async () => {
  const result = await window.orion?.themes?.importT3File?.();
  if (!result) return;
  if (!result.ok) toast.error(result.error);
  else if (result.value) toast.success(`Imported “${result.value.theme.name}” from T3 Code. It's in Settings → Themes.`);
};

/** Settings → Themes → Community: browse the gallery, install from a link, T3 Code themes. */
export const CommunityThemesSection: React.FC = () => {
  const [link, setLink] = useState('');
  return (
    <>
      <div className="settings-group-label">Community</div>
      <div className="settings-group">
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Community themes</div>
            <div className="setting-label-desc">
              Themes other people made, on durango.sh. Install one in a click, then ask an agent to remix it. Share your
              own from a theme's ⋯ menu.
            </div>
          </div>
          <button type="button" className="provider-auth-button" onClick={() => void window.orion?.themes?.openGallery?.()}>
            <Globe size={13} /> Browse
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">T3 Code themes</div>
            <div className="setting-label-desc">
              Import a theme exported from T3 Code (its colors and CSS). To use one of yours in T3 Code, choose Export for
              T3 Code from its ⋯ menu.
            </div>
          </div>
          <button type="button" className="provider-auth-button" onClick={() => void importT3File()}>
            <FileUp size={13} /> Import file…
          </button>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <div className="setting-label-title">Install from a link</div>
            <div className="setting-label-desc">Paste a theme link someone shared with you: a community theme or a T3 Code theme file.</div>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!link.trim()) return;
              openCommunityInstall(link);
              setLink('');
            }}
          >
            <input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="durango.sh/code/themes/… or a .json link"
              className="w-56 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
            <button type="submit" className="provider-auth-button" disabled={!link.trim()}>
              <Sparkles size={13} /> Open
            </button>
          </form>
        </div>
      </div>
    </>
  );
};
