export type TexPreviewPage = { base64: string; width: number; height: number }

export type TexPreviewView = {
  root?: string
  pdf?: string
  pages: number
  // The pages drawn, first to last: a window around the page last edited.
  first: number
  last: number
  // The page the last edit landed on, which the pane scrolls to.
  focus: number
  // Each drawn page's image by its number; a page still rendering has none.
  images: Record<string, TexPreviewPage>
  status: 'idle' | 'compiling' | 'ok' | 'error'
  // latexmk is settling references and the bibliography after the quick pass.
  isRefining?: boolean
  errors: string[]
  updatedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'tex-preview': { view: TexPreviewView }
  }
}
