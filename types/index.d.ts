export type TexPreviewPage = { base64: string; width: number; height: number }

export type TexPreviewView = {
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
