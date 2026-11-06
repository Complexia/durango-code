// Right-click menu for text in Orion's own window: spelling suggestions for a
// misspelled word, then the usual edit actions. Chromium has already checked
// the word and worked out the suggestions by the time 'context-menu' fires
// (macOS uses the system spellchecker), so this only builds a native menu on
// demand: nothing is loaded up front and nothing runs while typing.
//
// Elements with their own menu (the file tree) call preventDefault on the DOM
// event, and Chromium then never emits 'context-menu' here.

const MAX_SUGGESTIONS = 6;
const PREVIEW_CHARS = 24;

// "a fairly long selected sentence" -> "a fairly long selected…" (whole words).
function shortPreview(text) {
  const oneLine = text.replace(/\s+/g, ' ');
  if (oneLine.length <= PREVIEW_CHARS) return oneLine;
  const cut = oneLine.slice(0, PREVIEW_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Pure: the menu template for one right-click. `actions` are the side effects
// (kept out so this can be tested without Electron).
export function buildTextContextMenuTemplate(params, actions, platform = process.platform) {
  const {
    misspelledWord = '',
    dictionarySuggestions = [],
    isEditable = false,
    selectionText = '',
    linkURL = '',
    editFlags = {},
  } = params ?? {};
  const template = [];
  const section = (items) => {
    if (!items.length) return;
    if (template.length) template.push({ type: 'separator' });
    template.push(...items);
  };

  if (isEditable && misspelledWord) {
    const suggestions = dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    section([
      ...(suggestions.length
        ? suggestions.map((suggestion) => ({
            label: suggestion,
            click: () => actions.replaceMisspelling(suggestion),
          }))
        : [{ label: 'No Guesses Found', enabled: false }]),
      { type: 'separator' },
      {
        label: 'Learn Spelling',
        click: () => actions.learnWord(misspelledWord),
      },
    ]);
  }

  if (linkURL && /^https?:\/\//i.test(linkURL)) {
    section([
      { label: 'Open Link in Browser', click: () => actions.openExternal(linkURL) },
      { label: 'Copy Link', click: () => actions.copyText(linkURL) },
    ]);
  }

  const trimmedSelection = selectionText.trim();
  if (trimmedSelection && platform === 'darwin') {
    section([{ label: `Look Up “${shortPreview(trimmedSelection)}”`, click: () => actions.lookUp() }]);
  }

  if (isEditable) {
    section([
      { role: 'cut', enabled: Boolean(editFlags.canCut) },
      { role: 'copy', enabled: Boolean(editFlags.canCopy) },
      { role: 'paste', enabled: Boolean(editFlags.canPaste) },
      { role: 'selectAll', enabled: editFlags.canSelectAll !== false },
    ]);
  } else if (selectionText) {
    // Untrimmed: a selection of only spaces or line breaks is still copyable.
    section([{ role: 'copy' }]);
  }

  return template;
}

export function attachTextContextMenu(window, { Menu, clipboard, shell, externalUrl = (url) => url }) {
  const contents = window.webContents;
  contents.on('context-menu', (_event, params) => {
    const template = buildTextContextMenuTemplate(params, {
      replaceMisspelling: (word) => contents.replaceMisspelling(word),
      learnWord: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      openExternal: (url) => {
        const safe = externalUrl(url);
        if (safe) void shell.openExternal(safe).catch(() => {});
      },
      copyText: (text) => clipboard.writeText(text),
      lookUp: () => contents.showDefinitionForSelection(),
    });
    if (!template.length) return;
    // Open at the click point (also right for the keyboard's context-menu key).
    Menu.buildFromTemplate(template).popup({
      window,
      x: params.x,
      y: params.y,
      frame: params.frame ?? undefined,
      // Keyboard and touch openings, not just the mouse.
      sourceType: params.menuSourceType,
    });
  });
}
