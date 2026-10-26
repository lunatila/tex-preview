import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TexPreviewPage, TexPreviewPart, TexPreviewSource, TexPreviewView } from '../types'

const PANE = 'tex-preview'
// An Svg's source holds at most 131072 characters, the PNG's base64 included.
const SVG_ROOM = 130_000
// Best first; a page whose PNG does not fit falls to the next.
const RENDERS: string[][] = [
  ['-png', '-scale-to-x', '760'],
  ['-png', '-gray', '-scale-to-x', '800'],
  ['-png', '-gray', '-scale-to-x', '640'],
  ['-png', '-mono', '-scale-to-x', '800'],
  ['-png', '-gray', '-scale-to-x', '480'],
]
// Short enough to feel immediate, long enough to fold a burst of edits.
const SETTLE_MS = 250
// The text a tree's Inputs hold together; a longer file is not opened in the
// editor, since the field would hold only its head and a save would cut it.
const INPUT_ROOM = 100_000
// Pages past SyncTeX's that a chapter's start is looked for in.
const CHAPTER_SPAN = 20
// How far ◀◀ and ▶▶ jump.
const JUMP = 10
// Options a picker holds at most: a thesis's 160 headings in one list stalled
// the desktop pane, so chapters and the sections of one chapter are two lists.
const MAX_OPTIONS = 40
// A file longer than this opens a part at a time, well inside INPUT_ROOM.
const PART_ROOM = 60_000
// What a quick single pass leaves for latexmk to settle.
const UNSETTLED = /Rerun to get|There were undefined (references|citations)|Label\(s\) may have changed|No file .*\.(bbl|ind|gls)/

const INITIAL: TexPreviewView = { page: 1, pages: 0, status: 'idle', errors: [] }
const view = atom({ plugin: 'tex-preview', key: 'view' } as const, INITIAL)

type Jump = { file: string; line: number }
type Edit = { file: string; oldText: string; newText: string }

// Edits arrive in bursts: compile once the burst settles, one run at a time.
let timer: { cancel(): void } | undefined
let isRunning = false
let pendingRoot: string | undefined
let pendingEdit: Edit | undefined
let isPending = false
// Claude's last edit, for the editor to open the part that holds it.
let lastEdit: Edit | undefined
// The module's own caches: a reload starts them over, which costs one lookup.
const roots = new Map<string, string>()
const pages = new Map<string, TexPreviewPage>()
let firstRender = 0
let tmp: string | undefined
let opener: string[] | undefined

const slash = (path: string) => path.replace(/\\/g, '/')
const dirOf = (path: string) => slash(path).replace(/\/[^/]*$/, '')
const baseOf = (path: string) => slash(path).replace(/^.*\//, '')
const stemOf = (path: string) => baseOf(path).replace(/\.tex$/i, '')
const isTex = (path: unknown): path is string =>
  typeof path === 'string' && /\.tex$/i.test(path)

const readText = (path: string, $: EngineInterface) =>
  $.fs.read(path).then(
    text => (typeof text === 'string' ? text : ''),
    () => '',
  )

async function findRoot($: EngineInterface, file: string): Promise<string> {
  const known = roots.get(slash(file))
  if (known !== undefined) return known
  const root = await lookUpRoot($, file)
  roots.set(slash(file), root)

  return root
}

async function lookUpRoot($: EngineInterface, file: string): Promise<string> {
  const text = await readText(file, $)
  const magic = /^\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$/im.exec(text)?.[1]
  if (magic !== undefined) {
    const target = slash(magic)
    return /^([A-Za-z]:)?\//.test(target) ? target : `${dirOf(file)}/${target}`
  }
  if (/\\documentclass/.test(text)) return slash(file)

  // A chapter: look for the document that pulls it in, here and one level up.
  const stem = stemOf(file)
  const found: string[] = []
  for (const dir of [dirOf(file), dirOf(dirOf(file))]) {
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      if (entry.kind !== 'file' || !isTex(entry.name)) continue
      const path = `${dir}/${entry.name}`
      const body = await readText(path, $)
      if (!/\\documentclass/.test(body)) continue
      if (new RegExp(`\\\\(input|include|subfile)\\{[^}]*${stem}(\\.tex)?\\}`).test(body)) {
        return path
      }
      found.push(path)
    }
  }
  const { root } = await read($, view)

  return root ?? found[0] ?? slash(file)
}

// The line of the first character the edit changed, not of the context it kept.
async function jumpOf($: EngineInterface, edit: Edit): Promise<Jump | undefined> {
  if (edit.newText === '') return undefined
  const text = (await readText(edit.file, $)).replace(/\r\n/g, '\n')
  const at = text.indexOf(edit.newText)
  if (at < 0) return undefined
  let kept = 0
  while (
    kept < edit.oldText.length &&
    kept < edit.newText.length - 1 &&
    edit.oldText[kept] === edit.newText[kept]
  ) {
    kept++
  }

  return { file: slash(edit.file), line: text.slice(0, at + kept).split('\n').length }
}

function programOf(text: string): { engine: string; latexmk: string } {
  const program = /^\s*%\s*!TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(text)?.[1]?.toLowerCase()
  if (program === 'xelatex') return { engine: 'xelatex', latexmk: '-pdfxe' }
  if (program === 'lualatex') return { engine: 'lualatex', latexmk: '-pdflua' }
  if (program === 'pdflatex') return { engine: 'pdflatex', latexmk: '-pdf' }

  return /\\usepackage(\[[^\]]*\])?\{fontspec\}/.test(text)
    ? { engine: 'xelatex', latexmk: '-pdfxe' }
    : { engine: 'pdflatex', latexmk: '-pdf' }
}

function errorsOf(log: string): string[] {
  const found: string[] = []
  for (const line of log.split(/\r?\n/)) {
    const located = /^(.+?\.tex):(\d+): (.+)$/.exec(line)
    const bare = /^! (.+)$/.exec(line)
    const [, file = '', at = '', message = ''] = located ?? []
    const text = located ? `${baseOf(file)}:${at}  ${message}` : bare?.[1]
    if (text !== undefined && !found.includes(text)) found.push(text)
    if (found.length === 6) break
  }

  return found
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// A PNG's IHDR holds its width and height at bytes 16 and 20, big-endian.
function pngSize(base64: string): { width: number; height: number } {
  const head: number[] = []
  for (let i = 0; i < 32; i += 4) {
    const n = [...base64.slice(i, i + 4)].reduce((acc, c) => (acc << 6) | BASE64.indexOf(c), 0)
    head.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const byte = (i: number) => head[i] ?? 0
  const at = (i: number) => ((byte(i) << 24) | (byte(i + 1) << 16) | (byte(i + 2) << 8) | byte(i + 3)) >>> 0

  return { width: at(16), height: at(20) }
}

async function cacheDir($: EngineInterface): Promise<string> {
  if (tmp !== undefined) return tmp
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  const dir = `${slash(temp).replace(/\/$/, '')}/claude-tex-preview`
  await $.fs.write(`${dir}/.keep`, '')
  tmp = dir

  return dir
}

async function renderPage(
  $: EngineInterface,
  pdf: string,
  page: number,
): Promise<TexPreviewPage | undefined> {
  const cached = pages.get(`${pdf}#${page}`)
  if (cached !== undefined) return cached

  const out = `${await cacheDir($)}/page-${page}`
  // Start where the last page fit, so a document of dense pages pays no
  // failed attempt each time; a page that fits easily lets the next try better.
  for (let i = firstRender; i < RENDERS.length; i++) {
    const options = RENDERS[i] ?? []
    const argv = ['pdftocairo', ...options, '-scale-to-y', '-1', '-f', `${page}`, '-l', `${page}`]
    const ran = await $.process.run([...argv, '-singlefile', pdf, out], { timeoutMs: 60_000 })
    if (ran.exitCode !== 0) return undefined
    const { base64 } = await $.fs.read(`${out}.png`, { as: 'bytes' })
    if (base64.length > SVG_ROOM) continue
    firstRender = base64.length < SVG_ROOM / 2 ? Math.max(0, i - 1) : i
    const image = { base64, ...pngSize(base64) }
    pages.set(`${pdf}#${page}`, image)

    return image
  }

  return undefined
}

async function pageOf($: EngineInterface, pdf: string, jump: Jump): Promise<number | undefined> {
  const dir = dirOf(pdf)
  const file = slash(jump.file).startsWith(`${dir}/`) ? slash(jump.file).slice(dir.length + 1) : jump.file
  const ran = await $.process
    .run(['synctex', 'view', '-i', `${jump.line}:0:${file}`, '-o', pdf], { cwd: dir })
    .catch(() => undefined)
  const page = ran && /^Page:(\d+)/m.exec(ran.stdout)?.[1]

  return page ? Number(page) : undefined
}

async function showPage($: EngineInterface, page: number) {
  const { pdf, pages: count } = await read($, view)
  if (pdf === undefined) return
  const target = Math.min(Math.max(1, page), Math.max(1, count))
  const image = await renderPage($, pdf, target)
  await update($, view, v => ({ ...v, page: target, image: image ?? v.image }))
}

// The two pages either side of the one shown, so paging through is instant.
async function prefetch($: EngineInterface) {
  const { pdf, page, pages: count } = await read($, view)
  if (pdf === undefined) return
  for (const near of [page + 1, page - 1, page + 2, page - 2]) {
    if (isPending) return
    if (near >= 1 && near <= count) await renderPage($, pdf, near).catch(() => undefined)
  }
}

type Pass = { exitCode: number; stdout: string; stderr: string }

async function run($: EngineInterface, argv: string[], cwd: string): Promise<Pass> {
  return $.process
    .run(argv, { cwd, timeoutMs: 600_000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
}

// Reads what a pass left and shows it; answers whether the log asks for more.
async function settle($: EngineInterface, root: string, ran: Pass, page?: number): Promise<boolean> {
  const dir = dirOf(root)
  const pdf = `${dir}/${stemOf(root)}.pdf`
  const log = await readText(`${dir}/${stemOf(root)}.log`, $)
  const count = Number(/Output written on .*?\((\d+) pages?/.exec(log)?.[1] ?? 0)
  const errors = errorsOf(log)
  if (ran.exitCode !== 0 && errors.length === 0) {
    errors.push((ran.stderr || ran.stdout).trim().split(/\r?\n/).slice(-4).join('\n') || 'a compilação falhou')
  }
  const hasPdf = await $.fs.exists(pdf)
  for (const key of [...pages.keys()]) if (key.startsWith(`${pdf}#`)) pages.delete(key)
  const status: TexPreviewView['status'] = ran.exitCode === 0 ? 'ok' : 'error'
  await update($, view, v => ({
    ...v,
    root,
    pdf: hasPdf ? pdf : v.pdf,
    pages: count || v.pages,
    status,
    errors,
    updatedAt: Date.now(),
  }))
  if (hasPdf) await showPage($, page ?? (await read($, view)).page)

  return ran.exitCode === 0 && UNSETTLED.test(log)
}

async function compile($: EngineInterface, root: string, edit: Edit | undefined) {
  await update($, view, (v): TexPreviewView => ({ ...v, root, status: 'compiling', isRefining: false }))
  const dir = dirOf(root)
  const program = programOf(await readText(root, $))
  const flags = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1']

  // One pass of the engine shows the edit at once; references may lag a pass.
  const quick = await run($, [program.engine, ...flags, baseOf(root)], dir)
  const jump = edit && (await jumpOf($, edit))
  const pdf = `${dir}/${stemOf(root)}.pdf`
  const page = jump && (await pageOf($, pdf, jump))
  const needsMore = await settle($, root, quick, page)
  if (!needsMore || isPending) return

  // latexmk then settles references, citations and the bibliography.
  await update($, view, v => ({ ...v, isRefining: true }))
  const full = await run($, ['latexmk', program.latexmk, ...flags, baseOf(root)], dir)
  if (isPending) return
  await settle($, root, full)
  await update($, view, v => ({ ...v, isRefining: false }))
}

async function drain($: EngineInterface) {
  if (isRunning) return
  isRunning = true
  try {
    while (pendingRoot !== undefined || pendingEdit !== undefined) {
      const edit = pendingEdit
      const root = edit ? await findRoot($, edit.file) : pendingRoot
      pendingRoot = undefined
      pendingEdit = undefined
      isPending = false
      if (root !== undefined) await compile($, root, edit)
    }
    await prefetch($)
    if (!isPending) await indexSections($)
  } finally {
    isRunning = false
  }
}

// The .tex files the last compile read, as its log names them: `(./capitulos/
// 01-introducao.tex`. Empty when the log names none; the folder's are used then.
async function documentFiles($: EngineInterface, root: string): Promise<string[]> {
  const top = dirOf(root)
  const log = await readText(`${top}/${stemOf(root)}.log`, $)
  const named = new Set<string>()
  for (const match of log.matchAll(/\(\.\/([^()\s]+\.tex)/g)) if (match[1]) named.add(`${top}/${match[1]}`)

  return [...named]
}

// Letters and digits alone, lowercased and without accents: how a title and a
// page's text are compared.
const bare = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()

// SyncTeX places a chapter's heading on the page where TeX broke the page for
// it, before the floats still pending, so one or more pages early. The page
// where it really starts is the first from there whose top holds its title,
// read with pdftotext from the next CHAPTER_SPAN pages.
async function chapterPage($: EngineInterface, pdf: string, synced: number, title: string): Promise<number> {
  const wanted = bare(title).slice(0, 30)
  if (wanted.length < 4) return synced
  const ran = await $.process
    .run(['pdftotext', '-enc', 'UTF-8', '-f', `${synced}`, '-l', `${synced + CHAPTER_SPAN}`, baseOf(pdf), '-'], {
      cwd: dirOf(pdf),
      timeoutMs: 60_000,
    })
    .catch(() => undefined)
  if (ran === undefined || ran.exitCode !== 0) return synced
  const at = ran.stdout.split('\f').findIndex(page => bare(page).slice(0, 120).includes(wanted))

  return at < 0 ? synced : synced + at
}

// 0 a part or chapter, 1 a section, 2 a subsection, by the command's ending.
const levelOf = (command: string) => (/subsection$/.test(command) ? 2 : /section$/.test(command) ? 1 : 0)

type Heading = { file: string; line: number; label: string; level: number; order: number }

// Where each heading of the document landed, asked of SyncTeX one at a time
// (a query reads the whole SyncTeX file: about 140 ms on a 200-page thesis).
// Only the files the document read are asked, a level at a time from the
// top. Without a list yet, the pickers fill once each level is placed; with
// one, it stays until the new one is whole. Stops when a new compile is due.
async function indexSections($: EngineInterface) {
  const { root, pdf, sections: before } = await read($, view)
  if (root === undefined || pdf === undefined) return
  const listed = await documentFiles($, root)
  const files = listed.length > 0 ? listed : await texFiles($, root)

  const headings: Heading[] = []
  for (const file of files) {
    const text = (await readText(file, $)).replace(/\r\n/g, '\n')
    let line = 1
    let counted = 0
    for (const match of text.matchAll(HEADING)) {
      const label = headingLabel(match[1] ?? '', match[2] ?? '')
      if (label === undefined) continue
      const at = match.index ?? 0
      for (let i = counted; i < at; i++) if (text.charCodeAt(i) === 10) line++
      counted = at
      const level = levelOf(match[1] ?? '')
      headings.push({ file, line, label: label.trim(), level, order: headings.length })
    }
  }
  headings.sort((a, b) => a.level - b.level || a.order - b.order)

  const found: { label: string; page: number; level: number; order: number }[] = []
  const listOf = () =>
    [...found]
      .sort((a, b) => a.page - b.page || a.order - b.order)
      .map(({ label, page, level }) => ({ label, page, level }))
  const isFilling = before === undefined || before.length === 0
  for (const [i, heading] of headings.entries()) {
    if (isPending) return
    const synced = await pageOf($, pdf, heading)
    const page = synced !== undefined && heading.level === 0 ? await chapterPage($, pdf, synced, heading.label) : synced
    if (page !== undefined) found.push({ label: heading.label, page, level: heading.level, order: heading.order })
    const isLevelDone = headings[i + 1]?.level !== heading.level
    if (isFilling && isLevelDone && found.length > 0) {
      await update($, view, v => ({ ...v, sections: listOf(), sectionsLeft: headings.length - i - 1 }))
    }
  }
  await update($, view, v => ({ ...v, sections: listOf(), sectionsLeft: 0 }))
}

function schedule($: EngineInterface) {
  isPending = true
  timer?.cancel()
  timer = $.clock.after(SETTLE_MS, () => void drain($))
}

async function openPdf($: EngineInterface, pdf: string) {
  if (opener === undefined) {
    const system = /^[A-Za-z]:\//.test(pdf)
      ? 'Windows'
      : (await $.process.run(['uname']).catch(() => undefined))?.stdout.trim()
    opener =
      system === 'Windows' ? ['cmd', '/c', 'start', '']
      : system === 'Darwin' ? ['open']
      : ['xdg-open']
  }
  const path = opener[0] === 'cmd' ? pdf.replace(/\//g, '\\') : pdf
  await $.process.run([...opener, path]).catch(() => $.ui.toast(`Não consegui abrir ${pdf}`))
}

// The document's .tex files: its folder and the folders just below (chapters/).
async function texFiles($: EngineInterface, root: string): Promise<string[]> {
  const top = dirOf(root)
  const found: string[] = []
  const entries = await $.fs.list(top).catch(() => [])
  for (const entry of entries) {
    if (entry.kind === 'file' && isTex(entry.name)) found.push(`${top}/${entry.name}`)
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    for (const inner of await $.fs.list(`${top}/${entry.name}`).catch(() => [])) {
      if (inner.kind === 'file' && isTex(inner.name)) found.push(`${top}/${entry.name}/${inner.name}`)
    }
  }

  return found.sort().slice(0, 60)
}

// A heading at the start of a line opens a part: any command named for a part,
// chapter, section or subsection, a class's own included (\spesection), and
// the title after it. Subsubsections stay inside their part.
const HEADING = /^\\([a-zA-Z]*?(?:part|chapter|section))\*?\s*(?:\[[^\]\n]*\])?\s*\{([^\n]*)/gm

function headingLabel(command: string, rest: string): string | undefined {
  if (/subsubsection$/.test(command)) return undefined
  const title = rest
    .replace(/\}[^}]*$/, '')
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/~/g, ' ')
    .trim()
    .slice(0, 60)
  // A command's definition in the preamble (\spesection{#1}) is no heading.
  if (title === '' || title.includes('#')) return undefined
  return /subsection$/.test(command) ? `   ${title}` : title
}

// [start, end) cut at line breaks into pieces of at most PART_ROOM characters.
function splitLarge(full: string, start: number, end: number, label: string): TexPreviewPart[] {
  if (end - start <= PART_ROOM) return [{ label, start, end }]
  const cuts = [start]
  let at = start
  while (end - at > PART_ROOM) {
    const lineStart = full.lastIndexOf('\n', at + PART_ROOM - 1) + 1
    at = lineStart > at ? lineStart : at + PART_ROOM
    cuts.push(at)
  }
  cuts.push(end)

  return cuts.slice(0, -1).map((from, i) => ({
    label: `${label} (${i + 1}/${cuts.length - 1})`,
    start: from,
    end: cuts[i + 1] ?? end,
  }))
}

// The whole file when it fits the editor; else one part per heading, the text
// before the first heading its own part, each cut further when still large.
function partsOf(full: string): TexPreviewPart[] {
  if (full.length <= PART_ROOM) return [{ label: 'arquivo inteiro', start: 0, end: full.length }]
  const cuts = [{ at: 0, label: 'início (preâmbulo)' }]
  for (const match of full.matchAll(HEADING)) {
    const at = match.index ?? 0
    const label = headingLabel(match[1] ?? '', match[2] ?? '')
    if (at > 0 && label !== undefined) cuts.push({ at, label })
  }

  return cuts.flatMap((cut, i) => {
    const end = cuts[i + 1]?.at ?? full.length
    return end > cut.at ? splitLarge(full, cut.at, end, cut.label) : []
  })
}

const partAt = (parts: TexPreviewPart[], offset: number) =>
  Math.max(0, parts.findIndex(part => offset >= part.start && offset < part.end))

// The part holding Claude's last edit of the file, else the first.
function partOfLastEdit(path: string, full: string, parts: TexPreviewPart[]): number {
  if (lastEdit === undefined || lastEdit.file !== path || lastEdit.newText === '') return 0
  const at = full.indexOf(lastEdit.newText.replace(/\r\n/g, '\n'))

  return at < 0 ? 0 : partAt(parts, at)
}

async function readSource($: EngineInterface, path: string, wanted?: number): Promise<TexPreviewSource> {
  const raw = await readText(path, $)
  const full = raw.replace(/\r\n/g, '\n')
  const parts = partsOf(full)
  const part = Math.min(Math.max(0, wanted ?? partOfLastEdit(path, full, parts)), parts.length - 1)
  const { start = 0, end = full.length } = parts[part] ?? {}
  const text = full.slice(start, end)

  return { path, full, parts, part, text, draft: text, isCrlf: raw.includes('\r\n') }
}

async function openSource($: EngineInterface, path: string, wanted?: number) {
  const source = await readSource($, path, wanted)
  const { root } = await read($, view)
  const files = root ? await texFiles($, root) : [path]
  await update($, view, (v): TexPreviewView => ({
    ...v,
    mode: 'source',
    source,
    files: files.includes(path) ? files : [path, ...files],
  }))
}

// Puts the draft back in its place in the file, then shows the PDF at the
// first line it changed. A file changed on disk since it was read is not
// written over: the editor says so instead.
async function saveSource($: EngineInterface, draft: string) {
  const { source } = await read($, view)
  if (source === undefined) return
  const onDisk = (await readText(source.path, $)).replace(/\r\n/g, '\n')
  if (onDisk !== source.full) {
    await update($, view, v => ({ ...v, source: v.source && { ...v.source, isStale: true } }))
    return
  }
  const { start = 0, end = source.full.length } = source.parts[source.part] ?? {}
  const full = source.full.slice(0, start) + draft + source.full.slice(end)
  await $.fs.write(source.path, source.isCrlf ? full.replace(/\n/g, '\r\n') : full)

  // The same part, found again by where it starts, now holding the draft.
  const parts = partsOf(full)
  const part = partAt(parts, start)
  const { start: from = 0, end: to = full.length } = parts[part] ?? {}
  const text = full.slice(from, to)
  await update($, view, (v): TexPreviewView => ({
    ...v,
    mode: 'pdf',
    source: v.source && { ...v.source, full, parts, part, text, draft: text, isStale: false },
  }))
  pendingEdit = { file: source.path, oldText: source.text, newText: draft }
  schedule($)
}

// Claude edited the open file: take its version, unless the person has typed.
async function onDiskChange($: EngineInterface, path: string) {
  const { source } = await read($, view)
  if (source === undefined || source.path !== path) return
  if (source.draft === source.text) {
    const fresh = await readSource($, path, source.part)
    await update($, view, v => ({ ...v, source: fresh }))
  } else {
    await update($, view, v => ({ ...v, source: v.source && { ...v.source, isStale: true } }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tex',
      description: 'Compile a .tex (or the current one) and show its PDF in a pane',
      argumentHint: '[arquivo.tex]',
    })

    return next(e)
  })

  on('command.run', { command: 'tex' }, async ($, e) => {
    const asked = e.args.trim().replace(/^"|"$/g, '')
    const { root } = await read($, view)
    const cwd = slash(await $.session.root())
    const file = asked === '' ? root : /^([A-Za-z]:)?\//.test(slash(asked)) ? slash(asked) : `${cwd}/${slash(asked)}`
    await $.ui.open({ id: PANE, title: `PDF · ${file ? baseOf(file) : 'LaTeX'}` })
    if (file === undefined) return { text: 'Nenhum .tex ainda: use /tex arquivo.tex.' }
    pendingRoot = await findRoot($, file)
    schedule($)

    return { text: `Compilando ${baseOf(file)}…` }
  })

  // The edit's result goes back to the model at once; the work waits in a timer.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const file = 'file_path' in e ? e.file_path : undefined
    const isEdit = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit'
    if (!isEdit || !isTex(file) || ran.deny !== undefined || ran.isError === true) return ran

    const oldText = 'old_string' in e && typeof e.old_string === 'string' ? e.old_string : ''
    const newText = 'new_string' in e && typeof e.new_string === 'string' ? e.new_string : ''
    pendingEdit = { file: slash(file), oldText, newText }
    lastEdit = pendingEdit
    void $.ui.open({ id: PANE, title: `PDF · ${baseOf(roots.get(slash(file)) ?? file)}` })
    schedule($)
    await update($, view, v => ({ ...v, lastFile: slash(file) }))
    await onDiskChange($, slash(file))

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The terminal draws no Svg; it gets the PDF's path instead.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const v = await read($, view)
    const Input = 'Input' in table ? table.Input : undefined
    const Select = 'Select' in table ? table.Select : undefined

    if (v.mode === 'source' && v.source) {
      const source = v.source
      const files = v.files ?? []
      const isDirty = source.draft !== source.text
      const isTooLong = source.text.length > INPUT_ROOM
      // An Input refuses control characters but tab and newline; the pane would then draw nothing.
      const hasControl = /[\u0000-\u0008\u000b-\u001f\u007f]/.test(source.draft)
      const top = v.root ? `${dirOf(v.root)}/` : ''
      const hasParts = source.parts.length > 1
      const rows = Math.max(10, e.props.scroll.bodyRows - (hasParts ? 11 : 8))
      const setDraft = (draft: string) =>
        update($, view, x => ({ ...x, source: x.source && { ...x.source, draft } }))

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text bold>{baseOf(source.path)}</Text>
            {hasParts && <Text>{`· ${source.parts[source.part]?.label.trim() ?? ''}`}</Text>}
            <Text dimColor>
              {isDirty ? 'não salvo · Enter salva, Shift+Enter quebra a linha' : 'sem mudanças'}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button
              key="pdf"
              label="Ver PDF"
              onPress={() => void update($, view, (x): TexPreviewView => ({ ...x, mode: 'pdf' }))}
            />
            {!isTooLong && !hasControl && (
              <Button
                key="save"
                variant="primary"
                label="Salvar e compilar"
                onPress={() => void saveSource($, source.draft)}
              />
            )}
            {isDirty && <Button key="discard" label="Descartar" onPress={() => void setDraft(source.text)} />}
          </Box>
          {Select && files.length > 1 && (
            <Select
              key="file"
              label="Arquivo"
              value={source.path}
              options={files.map(path => ({
                value: path,
                label: path.startsWith(top) ? path.slice(top.length) : baseOf(path),
              }))}
              onSelect={path => {
                if (isDirty) $.ui.toast('Salve ou descarte as mudanças antes de trocar de arquivo.')
                else void openSource($, path)
              }}
            />
          )}
          {Select && hasParts && (
            <Select
              key="part"
              label="Seção"
              value={String(source.part)}
              options={source.parts.map((part, i) => ({ value: String(i), label: part.label }))}
              onSelect={value => {
                if (isDirty) $.ui.toast('Salve ou descarte as mudanças antes de trocar de seção.')
                else void openSource($, source.path, Number(value))
              }}
            />
          )}
          {source.isStale && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text color="yellow">
                O arquivo mudou no disco (pelo Claude ou outro editor) enquanto você editava; nada foi salvo.
              </Text>
              <Button
                key="reload"
                label="Recarregar (descarta o seu texto)"
                onPress={() => void openSource($, source.path, source.part)}
              />
            </Box>
          )}
          {isTooLong || hasControl || !Input ? (
            <Text color="yellow">
              {isTooLong
                ? `Este trecho tem ${source.text.length} caracteres numa só linha longa, mais do que o editor do painel comporta (${INPUT_ROOM}). Edite-o no seu editor.`
                : hasControl
                  ? 'Este trecho tem um caractere de controle que o campo de texto do painel não aceita. Edite-o no seu editor.'
                  : 'Esta superfície não tem campo de texto: edite o arquivo no seu editor.'}
            </Text>
          ) : (
            <Input
              key="source"
              rows={rows}
              value={source.draft}
              submitLabel="salvar"
              onInput={draft => void setDraft(draft)}
              onSubmit={draft => void saveSource($, draft)}
            />
          )}
        </Box>
      )
    }

    const label =
      v.status === 'compiling' ? 'compilando…'
      : v.status === 'error' ? 'erros na compilação'
      : v.status === 'ok' ? `página ${v.page} de ${v.pages || '?'}${v.isRefining ? ' · atualizando referências…' : ''}`
      : 'aguardando um .tex'
    const svg =
      v.image &&
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v.image.width} ${v.image.height}" width="${v.image.width}" height="${v.image.height}">` +
      `<rect width="100%" height="100%" fill="#fff"/>` +
      `<image href="data:image/png;base64,${v.image.base64}" width="${v.image.width}" height="${v.image.height}"/></svg>`
    const go = (page: number) => void showPage($, page).then(() => prefetch($))
    // Two pickers: the top level present (chapters, or sections when there are
    // none), and the headings below it inside the one the page shown is in.
    const sections = (v.sections ?? []).map((section, i) => ({ ...section, level: section.level ?? 1, i }))
    const topLevel = Math.min(...sections.map(section => section.level), 2)
    const tops = sections.filter(section => section.level === topLevel)
    const topAt = Math.max(0, tops.findLastIndex(section => section.page <= v.page))
    const inside = sections
      .slice((tops[topAt]?.i ?? -1) + 1, tops[topAt + 1]?.i ?? sections.length)
      .slice(0, MAX_OPTIONS)
    const insideAt = inside.findLastIndex(section => section.page <= v.page)
    const [topName, insideName] = topLevel === 0 ? ['Capítulo', 'Seção'] : ['Seção', 'Subseção']
    const finding = v.sectionsLeft ? ` (localizando mais ${v.sectionsLeft}…)` : ''

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text bold>{v.root ? baseOf(v.root) : 'LaTeX'}</Text>
          <Text dimColor={v.status !== 'error'} color={v.status === 'error' ? 'red' : undefined}>
            {label}
          </Text>
        </Box>
        {v.pages > 1 && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="first" label="⏮" onPress={() => go(1)} />
            <Button key="back10" label="◀◀ 10" onPress={() => go(v.page - JUMP)} />
            <Button key="prev" label="◀" hotkey="p" onPress={() => go(v.page - 1)} />
            <Button key="next" label="▶" hotkey="n" onPress={() => go(v.page + 1)} />
            <Button key="ahead10" label="10 ▶▶" onPress={() => go(v.page + JUMP)} />
            <Button key="last" label="⏭" onPress={() => go(v.pages)} />
            {Input && (
              <Input
                key="goto"
                label="Página"
                placeholder={`1–${v.pages}`}
                value=""
                submitLabel="ir"
                onSubmit={text => {
                  const page = Number.parseInt(text, 10)
                  if (Number.isFinite(page)) go(page)
                }}
              />
            )}
          </Box>
        )}
        {Select && tops.length > 1 && (
          <Select
            key="section"
            label={`${topName}${finding}`}
            value={String(topAt)}
            options={tops
              .slice(0, MAX_OPTIONS)
              .map((section, i) => ({ value: String(i), label: `${section.label} · p. ${section.page}` }))}
            onSelect={value => {
              const section = tops[Number(value)]
              if (section) go(section.page)
            }}
          />
        )}
        {Select && inside.length > 0 && (
          <Select
            key="subsection"
            label={insideName}
            value={insideAt < 0 ? undefined : String(insideAt)}
            options={inside.map((section, i) => ({
              value: String(i),
              label: `${section.level > topLevel + 1 ? '   ' : ''}${section.label} · p. ${section.page}`,
            }))}
            onSelect={value => {
              const section = inside[Number(value)]
              if (section) go(section.page)
            }}
          />
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            key="build"
            label="Recompilar"
            onPress={() => {
              if (v.root === undefined) return
              pendingRoot = v.root
              schedule($)
            }}
          />
          {v.pdf && <Button key="open" label="Abrir PDF" onPress={() => v.pdf && void openPdf($, v.pdf)} />}
          {Input && (v.lastFile ?? v.root) && (
            <Button
              key="edit"
              label="Editar .tex"
              onPress={() => {
                const path = v.lastFile ?? v.root
                if (path) void openSource($, path)
              }}
            />
          )}
        </Box>
        {v.errors.length > 0 && (
          <Box flexDirection="column">
            {v.errors.map(line => (
              <Text color="red">{line}</Text>
            ))}
          </Box>
        )}
        {svg && Svg ? (
          <Svg source={svg} alt={`Página ${v.page} de ${v.root ? baseOf(v.root) : 'PDF'}`} />
        ) : (
          <Text dimColor>
            {v.pdf ? `PDF em ${v.pdf}` : 'Edite um .tex na conversa ou use /tex arquivo.tex.'}
          </Text>
        )}
      </Box>
    )
  })
}
