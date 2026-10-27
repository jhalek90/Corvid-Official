import { app, clipboard, ipcMain, type BrowserWindow, type Session } from 'electron'
import type { ContextMenuAction, ContextMenuInfo } from '@shared/types'

// The menu itself is drawn by the renderer so it matches the app in both themes. Main only
// forwards what Chromium knows about the click (selection, edit state, spelling) and runs the
// edit commands, which act on the focused element the way the keyboard shortcuts do.
export function initContextMenu(win: BrowserWindow): void {
  configureSpellcheck(win.webContents.session)
  win.webContents.on('context-menu', (_e, p) => {
    const info: ContextMenuInfo = {
      selectionText: p.selectionText,
      isEditable: p.isEditable,
      canUndo: p.editFlags.canUndo,
      canRedo: p.editFlags.canRedo,
      canCut: p.editFlags.canCut,
      canCopy: p.editFlags.canCopy,
      canPaste: p.editFlags.canPaste,
      canSelectAll: p.editFlags.canSelectAll,
      misspelledWord: p.misspelledWord,
      suggestions: p.dictionarySuggestions.slice(0, 6),
      linkURL: p.linkURL
    }
    win.webContents.send('ctx:menu', info)
  })
  ipcMain.handle('ctx:run', async (e, action: ContextMenuAction, arg?: string) => {
    const wc = e.sender
    switch (action) {
      case 'undo':
      case 'redo':
      case 'cut':
      case 'copy':
      case 'paste':
      case 'selectAll':
        wc[action]()
        break
      case 'replace':
        if (arg) wc.replaceMisspelling(arg)
        break
      case 'learn':
        if (arg) wc.session.addWordToSpellCheckerDictionary(arg)
        break
      case 'copyText':
        if (arg) await clipboard.writeText(arg)
        break
    }
  })
}

// On Windows Chromium checks spelling with the system spell checker (Windows 8+), which needs no
// dictionary files. Hunspell .bdic files would only be fetched, from Google's CDN, for a language
// Windows can't check; the download URL points at loopback so that never leaves the machine.
function configureSpellcheck(ses: Session): void {
  ses.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/')
  const available = new Set(ses.availableSpellCheckerLanguages)
  const langs: string[] = []
  for (const l of app.getPreferredSystemLanguages()) {
    const code = available.has(l) ? l : available.has(l.split('-')[0]) ? l.split('-')[0] : undefined
    if (code && !langs.includes(code)) langs.push(code)
  }
  if (langs.length) ses.setSpellCheckerLanguages(langs.slice(0, 3))
}
