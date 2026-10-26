import { expect, test } from 'claude-code/testing'

declare const setTimeout: (fn: (value: unknown) => void, ms: number) => unknown

// A 600x800 PNG's signature and IHDR: all the mod reads of the page image.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAMgCAAAAAA='
const ROOT = 'C:/thesis/main.tex'
const CHAPTER = 'C:/thesis/cap1.tex'

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

test('editing a chapter compiles its root and shows the page it lands on', async ($, on) => {
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
  const written: { path: string; text: string }[] = []
  on('fs.write', (_, e) => {
    if (!e.path.endsWith('.keep')) written.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({
    value: [
      { name: 'main.tex', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
      { name: 'cap1.tex', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    ],
  }))
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

  // Done once the neighbours of the page shown are rendered too.
  const rendered = () => ran.filter(argv => argv[0] === 'pdftocairo').map(argv => argv[argv.indexOf('-f') + 1])
  for (let i = 0; i < 100 && !rendered().includes('1'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(opened).toContain('tex-preview')
  // A quick pass first, then latexmk, as the log asks for a rerun, then the
  // one heading of the document placed for the section picker.
  for (let i = 0; i < 100 && ran.filter(argv => argv[0] === 'synctex').length < 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const tools = ran.map(argv => argv[0]).filter(tool => tool !== 'pdftocairo')
  expect(tools).toEqual(['pdflatex', 'synctex', 'latexmk', 'synctex'])
  expect(ran.find(argv => argv[0] === 'pdflatex')).toContain('main.tex')
  expect(ran.find(argv => argv[0] === 'synctex')).toContain('3:0:cap1.tex')
  // Page 2 rendered after each pass, then pages 3 and 1 ahead of a press.
  expect(rendered()).toEqual(['2', '2', '3', '1'])

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: /página/ }))?.text).toBe('página 2 de 3')
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()

  // The editor opens the file Claude last edited; Enter saves and recompiles.
  await desktop.press({ key: 'edit' })
  expect((await desktop.find({ key: 'source' }))?.text).toBe('one\ntwo\n\\section{Novo}\nthree\n')
  const changed = 'one\ntwo\n\\section{Mudado}\nthree\n'
  await desktop.input({ key: 'source', text: changed, kind: 'change' })
  expect(await desktop.find({ type: 'Text', text: /não salvo/ })).toBeDefined()
  const passes = ran.filter(argv => argv[0] === 'pdflatex').length
  await desktop.input({ key: 'source', text: changed })
  expect(written).toContainEqual({ path: CHAPTER, text: changed })
  for (let i = 0; i < 100 && ran.filter(argv => argv[0] === 'pdflatex').length === passes; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(ran.filter(argv => argv[0] === 'pdflatex')).toHaveLength(passes + 1)
  // Back on the PDF once saved.
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /PDF em/ }))?.text).toBe('PDF em C:/thesis/main.pdf')
  await terminal.unmount()
})

// A file past the editor's room opens a section at a time, and a save puts the
// section back in its place in the whole file.
test('a long file is edited a section at a time and saved back whole', async ($, on) => {
  const MAIN = 'C:/paper/main.tex'
  const filler = `${'a'.repeat(79)}\n`.repeat(500)
  // A backslash, spelled so no escape in this file can turn it into a control character.
  const B = String.fromCharCode(92)
  let disk =
    `${B}documentclass{spe}\n${B}renewcommand{${B}spesection}[1]{${B}section*{#1}}\n${B}begin{document}\n` +
    `${B}spesection{Introduction}\n${filler}` +
    `${B}spesection{Results}\nRESULTS-EDIT here\n${filler}` +
    `${B}end{document}\n`
  const written: string[] = []
  const ran: string[][] = []
  on('command.register', () => ({ value: { command: 'tex' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.after', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'C:/Temp' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'main.tex', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.write', (_, e) => {
    if (!e.path.endsWith('.keep')) {
      written.push(e.text)
      disk = e.text
    }
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    if (e.as === 'bytes') return { value: { base64: PNG } }
    if (e.path.endsWith('main.log')) return { value: 'Output written on main.pdf (9 pages, 9 bytes).' }
    return { value: disk }
  })
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[0] === 'synctex' ? 'Page:5\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: 'C:/paper', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: MAIN, old_string: 'RESULTS', new_string: 'RESULTS-EDIT' })
  for (let i = 0; i < 100 && !ran.some(argv => argv[0] === 'pdftocairo'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // It opens the section holding Claude's last edit, not the whole file.
  await desktop.press({ key: 'edit' })
  expect((await desktop.find({ type: 'Text', text: /Results/ }))?.text).toBe('· Results')
  const opened = (await desktop.find({ key: 'source' }))?.text ?? ''
  expect(opened.startsWith(`${B}spesection{Results}\nRESULTS-EDIT here\n`)).toBe(true)
  expect(opened.length).toBeLessThan(60_000)

  // A save puts the section back between the others, the rest untouched.
  const edited = opened.replace('RESULTS-EDIT here', 'RESULTS rewritten')
  const before = disk
  await desktop.input({ key: 'source', text: edited })
  expect(written.at(-1)).toBe(before.replace('RESULTS-EDIT here', 'RESULTS rewritten'))

  // Another section is picked by its title, and opens alone.
  await desktop.press({ key: 'edit' })
  await desktop.select({ key: 'part', value: '1' })
  const intro = (await desktop.find({ key: 'source' }))?.text ?? ''
  expect(intro.startsWith(`${B}spesection{Introduction}\n`)).toBe(true)

  // A file changed on disk meanwhile is not written over.
  disk = disk.replace(`${B}begin{document}`, `${B}begin{document}\n% changed elsewhere`)
  const writes = written.length
  await desktop.input({ key: 'source', text: `${intro}more\n` })
  expect(written).toHaveLength(writes)
  expect(await desktop.find({ type: 'Text', text: /mudou no disco/ })).toBeDefined()
  await desktop.unmount()
})

// A long document is crossed by section, by page number and by ten pages.
test('the pane jumps by section, page number and ten pages', async ($, on) => {
  const MAIN = 'C:/thesis/main.tex'
  const B = String.fromCharCode(92)
  // Headings on lines 3, 5 and 7; SyncTeX places line n on page 4n.
  const disk = `${B}documentclass{book}\n${B}begin{document}\n${B}chapter{One}\nx\n${B}chapter{Second Results}\ny\n${B}section{Three}\n${B}end{document}\n`
  const shown: number[] = []
  on('command.register', () => ({ value: { command: 'tex' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/thesis' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.after', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'C:/Temp' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.write', () => ({ value: undefined }))
  // A draft beside the document, which the log shows it never read.
  on('fs.list', () => ({
    value: [
      { name: 'main.tex', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
      { name: 'draft.tex', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    ],
  }))
  on('fs.read', (_, e) => {
    if (e.as === 'bytes') return { value: { base64: PNG } }
    if (e.path.endsWith('main.log')) return { value: '(./main.tex\nOutput written on main.pdf (40 pages, 9 bytes).' }
    return { value: disk }
  })
  const asked: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'synctex') asked.push(e.argv[e.argv.indexOf('-i') + 1] ?? '')
    const at = e.argv.indexOf('-i')
    const line = at < 0 ? 0 : Number((e.argv[at + 1] ?? '').split(':')[0])
    if (e.argv[0] === 'pdftocairo') shown.push(Number(e.argv[e.argv.indexOf('-f') + 1]))
    // Chapter Second Results' title is typeset a page after the one SyncTeX gives, past
    // a page of the previous chapter's floats, as LaTeX does.
    if (e.argv[0] === 'pdftotext') {
      const from = Number(e.argv[e.argv.indexOf('-f') + 1])
      const text = from === 20 ? 'Chapter 1. One 20\nFigure 1.3\f2\nSecond Results\nIt begins.\f' : 'Chapter 1. One\f'
      return { value: { exitCode: 0, stdout: text, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout = e.argv[0] === 'synctex' ? `Page:${line * 4}\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: 'C:/thesis', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'tex', args: MAIN, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const page = async () => (await desktop.find({ type: 'Text', text: /página/ }))?.text
  for (let i = 0; i < 100 && (await desktop.find({ key: 'section' })) === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(await page()).toBe('página 1 de 40')

  // Ten ahead, then the last page and the first.
  await desktop.press({ key: 'ahead10' })
  expect(await page()).toBe('página 11 de 40')
  await desktop.press({ key: 'last' })
  expect(await page()).toBe('página 40 de 40')
  await desktop.press({ key: 'back10' })
  expect(await page()).toBe('página 30 de 40')
  await desktop.press({ key: 'first' })
  expect(await page()).toBe('página 1 de 40')

  // A page typed in, then one out of range lands on the last.
  await desktop.input({ key: 'goto', text: '25' })
  expect(await page()).toBe('página 25 de 40')
  await desktop.input({ key: 'goto', text: '999' })
  expect(await page()).toBe('página 40 de 40')

  // The sections, in order with their pages; picking one goes there.
  // Chapter Second Results: SyncTeX says page 20, its title is at the top of page 21.
  await desktop.select({ key: 'section', value: '1' })
  expect(await page()).toBe('página 21 de 40')
  // Inside that chapter, its section; chapters and sections are two pickers.
  await desktop.select({ key: 'subsection', value: '0' })
  expect(await page()).toBe('página 28 de 40')

  // Only the file the document read was asked about; chapters before sections.
  expect(asked.some(query => query.includes('draft.tex'))).toBe(false)
  expect(asked).toEqual(['3:0:main.tex', '5:0:main.tex', '7:0:main.tex'])
  await desktop.unmount()
})

// "Editar esta página" opens the editor where the page shown begins: the
// paragraph SyncTeX's inverse search names, saved back in its place.
test('the editor opens at the page shown and saves that stretch back', async ($, on) => {
  const MAIN = 'C:/thesis/main.tex'
  const B = String.fromCharCode(92)
  let disk = `${B}documentclass{article}\n${B}begin{document}\nIntro text.\n\nPage two starts here\nand goes on.\n\nMore text.\n${B}end{document}\n`
  const written: string[] = []
  on('command.register', () => ({ value: { command: 'tex' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'C:/thesis' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.after', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'C:/Temp' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'main.tex', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.write', (_, e) => {
    if (!e.path.endsWith('.keep')) {
      written.push(e.text)
      disk = e.text
    }
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    if (e.as === 'bytes') return { value: { base64: PNG } }
    if (e.path.endsWith('main.log')) return { value: '(./main.tex\nOutput written on main.pdf (3 pages, 9 bytes).' }
    return { value: disk }
  })
  on('process.run', (_, e) => {
    // Every point of page 2 answers line 6, the end of the paragraph that starts on line 5.
    const stdout = e.argv[0] === 'synctex' && e.argv[1] === 'edit' ? 'Input:C:/thesis/./main.tex\nLine:6\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: 'C:/thesis', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'tex', args: MAIN, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (let i = 0; i < 100 && (await desktop.find({ type: 'Text', text: /página 1 de 3/ })) === undefined; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await desktop.press({ key: 'next' })

  await desktop.press({ key: 'edit' })
  expect((await desktop.find({ type: 'Text', text: /linha/ }))?.text).toBe('· a partir da linha 5')
  const opened = (await desktop.find({ key: 'source' }))?.text ?? ''
  expect(opened.startsWith('Page two starts here\nand goes on.\n')).toBe(true)

  const before = disk
  await desktop.input({ key: 'source', text: opened.replace('Page two starts here', 'Page two, rewritten') })
  expect(written.at(-1)).toBe(before.replace('Page two starts here', 'Page two, rewritten'))

  // From the middle of the file, the whole of it is a press away.
  await desktop.press({ key: 'edit' })
  await desktop.press({ key: 'whole' })
  expect((await desktop.find({ key: 'source' }))?.text).toBe(disk)
  await desktop.unmount()
})
