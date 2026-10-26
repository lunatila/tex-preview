import { expect, test } from 'claude-code/testing'

declare const setTimeout: (fn: (value: unknown) => void, ms: number) => unknown

// A 600x800 PNG's signature and IHDR: all the mod reads of the page image.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAMgCAAAAAA='
const CHAPTER = 'C:/thesis/cap1.tex'
const file = (name: string, mtimeMs = 0) => ({ name, kind: 'file' as const, size: 1, mtimeMs, isLink: false })

const PANE = {
  plugin: 'tex-preview',
  component: 'Pane',
  requestId: 'tex-preview',
  props: {
    title: 'PDF',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('editing a chapter compiles its root and shows every page around the edit',async ($, on) => {
  const opened: string[] = []
  const ran: string[][] = []
  on('command.register', () => ({ value: { command: 'tex' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('clock.after', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'C:/Temp' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', (_, e) =>
    e.path.endsWith('claude-tex-preview')
      ? { value: [file('range-1.png', 5), file('range-3.png', 5), file('page.png')] }
      : { value: [file('main.tex'), file('cap1.tex')] },
  )
  on('fs.read', (_, e) => {
    if (e.as === 'bytes') return { value: { base64: PNG } }
    if (e.path.endsWith('main.tex')) return { value: '\\documentclass{article}\n\\input{cap1}\n' }
    if (e.path.endsWith('main.log')) {
      return { value: 'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.\nOutput written on main.pdf (3 pages, 9 bytes).' }
    }
    return { value: 'one\ntwo\n\\section{Novo}\nthree\n' }
  })
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[0] === 'synctex' ? 'SyncTeX result begin\nPage:2\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: 'C:/thesis', surface: 'desktop', isInteractive: true })
  // The edit keeps line "two" as context; the jump goes to the line it adds.
  await $.tool.call({ tool: 'Edit', file_path: CHAPTER, old_string: 'two\n', new_string: 'two\n\\section{Novo}\n' })

  const isSettled = () => ran.filter(argv => argv[0] === 'pdftocairo').length === 6
  for (let i = 0; i < 100 && !isSettled(); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(opened).toContain('tex-preview')
  // A quick pass, then latexmk as the log asks for a rerun; after each, the
  // edited page alone and then the pages before and after it in runs.
  const ranges = ran.map(argv => (argv[0] === 'pdftocairo' ? `${argv[argv.indexOf('-f') + 1]}-${argv[argv.indexOf('-l') + 1]}` : argv[0]))
  expect(ranges).toEqual(['pdflatex', 'synctex', '2-2', '1-1', '3-3', 'latexmk', '2-2', '1-1', '3-3'])
  expect(ran.find(argv => argv[0] === 'synctex')).toContain('3:0:cap1.tex')

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: /páginas/ }))?.text).toBe('3 páginas')
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(3)
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /PDF em/ }))?.text).toBe('PDF em C:/thesis/main.pdf')
  await terminal.unmount()
})
