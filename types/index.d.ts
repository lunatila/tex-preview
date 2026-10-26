export type TexPreviewPage = { base64: string; width: number; height: number }

// A stretch of a .tex the editor opens alone: the whole file when it is small,
// else a section (from its heading to the next), cut further if still large.
export type TexPreviewPart = { label: string; start: number; end: number }

// A .tex open in the pane's editor.
export type TexPreviewSource = {
  path: string
  // The whole file as last read or saved, its line breaks as `\n`.
  full: string
  // The file's parts, and the one holding the stretch open.
  parts: TexPreviewPart[]
  part: number
  // The stretch open, [start, end) of `full`: a part, or from the line the
  // page shown starts on to the end of its part; and how the editor names it.
  start: number
  end: number
  label: string
  // The stretch open as last read or saved.
  text: string
  // What the person has typed since.
  draft: string
  // The file's own line breaks are `\r\n`, put back on save.
  isCrlf: boolean
  // Claude changed the file on disk while the draft held edits of its own.
  isStale?: boolean
}

export type TexPreviewView = {
  // The page of the PDF, or the editor.
  mode?: 'pdf' | 'source'
  source?: TexPreviewSource
  // The .tex files of the document's folder and the folders just below it.
  files?: string[]
  // The .tex Claude last edited: the one the editor opens first.
  lastFile?: string
  // The document's sections and the page each starts on, found with SyncTeX
  // after a compile, for the pane's picker.
  // `level`: 0 a part or chapter, 1 a section, 2 a subsection.
  sections?: { label: string; page: number; level?: number }[]
  // Headings still to be placed while the picker first fills.
  sectionsLeft?: number
  root?: string
  pdf?: string
  page: number
  pages: number
  status: 'idle' | 'compiling' | 'ok' | 'error' | 'installing'
  // The programs the mod runs that this machine lacks: the pane offers to
  // install TinyTeX, or says how to get what TeX Live does not ship.
  missingTools?: string[]
  // A file the last compile could not find (`xyz.sty`), which the pane
  // offers to install with tlmgr.
  missingFile?: string
  // What an install under way is doing, or how the last one failed.
  installNote?: string
  // latexmk is settling references and the bibliography after the quick pass.
  isRefining?: boolean
  errors: string[]
  image?: TexPreviewPage
  updatedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'tex-preview': { view: TexPreviewView }
  }
}
