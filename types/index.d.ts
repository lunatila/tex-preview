export type TexPreviewPage = { base64: string; width: number; height: number }

// A stretch of a .tex the editor opens alone: the whole file when it is small,
// else a section (from its heading to the next), cut further if still large.
export type TexPreviewPart = { label: string; start: number; end: number }

// A .tex open in the pane's editor.
export type TexPreviewSource = {
  path: string
  // The whole file as last read or saved, its line breaks as `\n`.
  full: string
  // The file's parts and the one open.
  parts: TexPreviewPart[]
  part: number
  // The open part as last read or saved.
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
  sections?: { label: string; page: number }[]
  root?: string
  pdf?: string
  page: number
  pages: number
  status: 'idle' | 'compiling' | 'ok' | 'error'
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
