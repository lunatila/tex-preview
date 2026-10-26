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
// Points asked down a page to find where it begins in the source, in big
// points from its top left: the left margin, from below a running head on.
const PAGE_PROBE_X = 90
const PAGE_PROBES = [100, 160, 240, 320, 400, 480, 560, 640]
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

// The programs the mod runs. Without the first three nothing compiles or
// shows; without the last two, pages are not found from the source.
const TOOLS = ['pdflatex', 'latexmk', 'pdftocairo', 'synctex', 'pdftotext']
// TinyTeX's official installers, run only on the person's press.
const TINYTEX_WINDOWS = 'https://tinytex.yihui.org/install-bin-windows.bat'
const TINYTEX_UNIX = 'https://tinytex.yihui.org/install-bin-unix.sh'
// What TinyTeX lacks of the tools, per system (Windows' pdftocairo and
// pdftotext come in wintools; elsewhere they are poppler's, not TeX Live's).
const EXTRAS_WINDOWS = ['latexmk', 'synctex', 'wintools.windows']
const EXTRAS_UNIX = ['latexmk', 'synctex']

let checkedTools: string[] | undefined

const isWindowsPath = (path: string) => /^[A-Za-z]:\//.test(slash(path))

// A tool is there when it starts; its exit status says nothing here.
const canRun = ($: EngineInterface, tool: string) =>
  $.process.run([tool, tool === 'synctex' ? 'help' : '-v'], { timeoutMs: 20_000 }).then(
    () => true,
    () => false,
  )

// Where TinyTeX's programs are, when installed in its default place.
async function tinyTexBins($: EngineInterface, isWindows: boolean): Promise<string[]> {
  if (isWindows) {
    const places = [await $.env.get('APPDATA'), await $.env.get('ProgramData')]
    return places.filter((place): place is string => !!place).map(place => `${slash(place)}/TinyTeX/bin/windows`)
  }
  const home = await $.env.get('HOME')
  if (!home) return []
  return ['universal-darwin', 'x86_64-darwin', 'x86_64-linux', 'aarch64-linux'].flatMap(arch => [
    `${home}/Library/TinyTeX/bin/${arch}`,
    `${home}/.TinyTeX/bin/${arch}`,
  ])
}

// Puts an installed TinyTeX ahead on the PATH this session's programs get:
// the installer adds it for new sessions only.
async function useTinyTex($: EngineInterface, isWindows: boolean): Promise<boolean> {
  for (const bin of await tinyTexBins($, isWindows)) {
    if (!(await $.fs.exists(`${bin}/${isWindows ? 'tlmgr.bat' : 'tlmgr'}`))) continue
    const path = (await $.env.get('PATH')) ?? ''
    const native = isWindows ? bin.replace(/\//g, '\\') : bin
    if (!path.split(isWindows ? ';' : ':').includes(native)) {
      await $.env.set('PATH', `${native}${isWindows ? ';' : ':'}${path}`)
    }
    return true
  }
  return false
}

// The tools this machine lacks, after looking for TinyTeX too; once per
// session, again after an install.
async function missingTools($: EngineInterface, root: string): Promise<string[]> {
  if (checkedTools !== undefined) return checkedTools
  const check = async () => {
    const missing: string[] = []
    for (const tool of TOOLS) if (!(await canRun($, tool))) missing.push(tool)
    return missing
  }
  let missing = await check()
  if (missing.length > 0 && (await useTinyTex($, isWindowsPath(root)))) missing = await check()
  checkedTools = missing

  return missing
}

// TinyTeX, downloaded and installed by its official script, then the tools
// it lacks; then the document compiles again. Only on the person's press.
async function installTex($: EngineInterface) {
  const { root } = await read($, view)
  if (root === undefined) return
  const isWindows = isWindowsPath(root)
  const note = (installNote: string) =>
    update($, view, (v): TexPreviewView => ({ ...v, status: 'installing', installNote }))

  await note('baixando e instalando o TinyTeX… (alguns minutos)')
  // On Windows the script is fetched, then run, in the temporary folder: two
  // plain commands, with no quoting for cmd to misread.
  const temp = isWindows ? slash((await $.env.get('TEMP')) ?? dirOf(root)) : dirOf(root)
  const fetched = isWindows ? await run($, ['curl.exe', '-fsSLO', TINYTEX_WINDOWS], temp) : undefined
  const installed =
    fetched !== undefined && fetched.exitCode !== 0
      ? fetched
      : await run($, isWindows ? ['cmd', '/c', 'install-bin-windows.bat'] : ['sh', '-c', `curl -fsSL ${TINYTEX_UNIX} | sh`], temp)
  if (installed.exitCode !== 0 || !(await useTinyTex($, isWindows))) {
    const why = (installed.stderr || installed.stdout).trim().split(/\r?\n/).slice(-3).join(' ')
    await update($, view, (v): TexPreviewView => ({
      ...v,
      status: 'error',
      installNote: `A instalação do TinyTeX falhou: ${why || 'sem mensagem'}`,
    }))
    return
  }

  await note('instalando latexmk, synctex e as ferramentas de PDF…')
  await run($, ['tlmgr', 'install', ...(isWindows ? EXTRAS_WINDOWS : EXTRAS_UNIX)], dirOf(root))
  checkedTools = undefined
  const missing = await missingTools($, root)
  await update($, view, (v): TexPreviewView => ({
    ...v,
    status: 'idle',
    missingTools: missing,
    installNote: missing.length > 0 ? undefined : 'TinyTeX instalado.',
  }))
  if (missing.length > 0) return
  pendingRoot = root
  schedule($)
}

// The package holding `file` (tlmgr's search over the package catalogue),
// installed with tlmgr; then the document compiles again.
async function installPackage($: EngineInterface, file: string) {
  const { root } = await read($, view)
  if (root === undefined) return
  await update($, view, (v): TexPreviewView => ({
    ...v,
    status: 'installing',
    installNote: `procurando o pacote que tem ${file}…`,
  }))
  const found = await run($, ['tlmgr', 'search', '--global', '--file', `/${file}`], dirOf(root))
  const name = /^([A-Za-z0-9][\w.-]*):\s*$/m.exec(found.stdout)?.[1]
  if (name === undefined) {
    await update($, view, (v): TexPreviewView => ({
      ...v,
      status: 'error',
      installNote: `Nenhum pacote do TeX Live tem ${file}.`,
    }))
    return
  }
  await update($, view, (v): TexPreviewView => ({ ...v, installNote: `instalando o pacote ${name}…` }))
  const installed = await run($, ['tlmgr', 'install', name], dirOf(root))
  if (installed.exitCode !== 0) {
    const why = (installed.stderr || installed.stdout).trim().split(/\r?\n/).slice(-3).join(' ')
    await update($, view, (v): TexPreviewView => ({
      ...v,
      status: 'error',
      installNote: `tlmgr não instalou ${name}: ${why}`,
    }))
    return
  }
  await update($, view, (v): TexPreviewView => ({
    ...v,
    missingFile: undefined,
    installNote: `Pacote ${name} instalado.`,
  }))
  pendingRoot = root
  schedule($)
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
  // A class or package the machine does not have: tlmgr can fetch it.
  const missingFile = /! LaTeX Error: File `([^']+)' not found/.exec(log)?.[1]
  await update($, view, v => ({
    ...v,
    root,
    pdf: hasPdf ? pdf : v.pdf,
    pages: count || v.pages,
    status,
    errors,
    missingFile,
    updatedAt: Date.now(),
  }))
  if (hasPdf) await showPage($, page ?? (await read($, view)).page)

  return ran.exitCode === 0 && UNSETTLED.test(log)
}

async function compile($: EngineInterface, root: string, edit: Edit | undefined) {
  await update($, view, (v): TexPreviewView => ({ ...v, root, status: 'compiling', isRefining: false }))
  // Without LaTeX, or what draws a page, there is nothing to run: the pane
  // offers to install it instead.
  const missing = await missingTools($, root)
  const isBlocked = missing.some(tool => tool === 'pdflatex' || tool === 'latexmk' || tool === 'pdftocairo')
  await update($, view, (v): TexPreviewView => ({
    ...v,
    missingTools: missing,
    status: isBlocked ? 'error' : v.status,
    errors: isBlocked ? [] : v.errors,
  }))
  if (isBlocked) return
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

// Long work a press starts runs from a timer, so the end of the press's own
// dispatch does not cut it short.
function later($: EngineInterface, work: () => Promise<unknown>) {
  $.clock.after(0, () => void work())
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

// The offset where line `line` (1-based) of `text` starts.
function offsetOfLine(text: string, line: number): number {
  let at = 0
  for (let i = 1; i < line; i++) {
    const next = text.indexOf('\n', at)
    if (next < 0) return text.length
    at = next + 1
  }

  return at
}

const lineOfOffset = (text: string, offset: number) => text.slice(0, offset).split('\n').length

// What the editor opens: a part by index, or from a line to the end of the
// part holding it (the page shown); neither, the part of Claude's last edit.
type Opening = { part?: number; line?: number }

async function readSource($: EngineInterface, path: string, opening: Opening = {}): Promise<TexPreviewSource> {
  const raw = await readText(path, $)
  const full = raw.replace(/\r\n/g, '\n')
  const parts = partsOf(full)
  const at = opening.line === undefined ? undefined : offsetOfLine(full, opening.line)
  const wanted = at === undefined ? (opening.part ?? partOfLastEdit(path, full, parts)) : partAt(parts, at)
  const part = Math.min(Math.max(0, wanted), parts.length - 1)
  const { start: partStart = 0, end = full.length, label: partLabel = '' } = parts[part] ?? {}
  const start = at === undefined ? partStart : Math.max(partStart, at)
  const line = lineOfOffset(full, start)
  const name = parts.length > 1 ? partLabel.trim() : ''
  const label = start === partStart ? name : [name, `a partir da linha ${line}`].filter(Boolean).join(' · ')
  const text = full.slice(start, end)

  return { path, full, parts, part, start, end, label, text, draft: text, isCrlf: raw.includes('\r\n') }
}

async function openSource($: EngineInterface, path: string, opening: Opening = {}) {
  const source = await readSource($, path, opening)
  const { root } = await read($, view)
  const files = root ? await texFiles($, root) : [path]
  await update($, view, (v): TexPreviewView => ({
    ...v,
    mode: 'source',
    source,
    files: files.includes(path) ? files : [path, ...files],
  }))
}

// The source line a point of a page comes from, by SyncTeX's inverse search;
// the point in big points from the page's top left.
async function sourceAt(
  $: EngineInterface,
  pdf: string,
  page: number,
  x: number,
  y: number,
): Promise<{ file: string; line: number } | undefined> {
  const ran = await $.process
    .run(['synctex', 'edit', '-o', `${page}:${x}:${y}:${baseOf(pdf)}`], { cwd: dirOf(pdf), timeoutMs: 30_000 })
    .catch(() => undefined)
  const input = ran && /^Input:(.+)$/m.exec(ran.stdout)?.[1]?.trim()
  const line = ran && Number(/^Line:(\d+)/m.exec(ran.stdout)?.[1] ?? 0)
  if (!input || !line) return undefined
  // An absolute path, or one relative to the PDF's folder, `./` steps dropped.
  const path = slash(/^([A-Za-z]:)?\//.test(slash(input)) ? input : `${dirOf(pdf)}/${input}`).replace(/\/\.\//g, '/')

  return { file: path, line }
}

// The editor, opened where the page shown begins. A point of a page answers
// the line its paragraph ends on, so points down the page are asked and the
// least line of the file most of them name is taken, then moved back to the
// start of its paragraph. Without an answer, the file Claude last edited.
async function openAtPage($: EngineInterface) {
  const { pdf, page, root, lastFile } = await read($, view)
  const fallback = lastFile ?? root
  if (pdf === undefined) {
    if (fallback) await openSource($, fallback)
    return
  }
  const hits: { file: string; line: number }[] = []
  for (const y of PAGE_PROBES) {
    const hit = await sourceAt($, pdf, page, PAGE_PROBE_X, y)
    if (hit) hits.push(hit)
  }
  const counts = new Map<string, number>()
  for (const hit of hits) counts.set(hit.file, (counts.get(hit.file) ?? 0) + 1)
  const file = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (file === undefined) {
    if (fallback) await openSource($, fallback)
    return
  }
  const line = Math.min(...hits.filter(hit => hit.file === file).map(hit => hit.line))
  const lines = (await readText(file, $)).replace(/\r\n/g, '\n').split('\n')
  let start = line
  while (start > 1 && (lines[start - 2] ?? '').trim() !== '') start--
  await openSource($, file, { line: start })
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
  const { start, end } = source
  const full = source.full.slice(0, start) + draft + source.full.slice(end)
  await $.fs.write(source.path, source.isCrlf ? full.replace(/\n/g, '\r\n') : full)

  // The same stretch, now holding the draft.
  const parts = partsOf(full)
  await update($, view, (v): TexPreviewView => ({
    ...v,
    mode: 'pdf',
    source: v.source && {
      ...v.source,
      full,
      parts,
      part: partAt(parts, start),
      end: start + draft.length,
      text: draft,
      draft,
      isStale: false,
    },
  }))
  pendingEdit = { file: source.path, oldText: source.text, newText: draft }
  schedule($)
}

// Claude edited the open file: take its version, unless the person has typed.
async function onDiskChange($: EngineInterface, path: string) {
  const { source } = await read($, view)
  if (source === undefined || source.path !== path) return
  if (source.draft === source.text) {
    const fresh = await readSource($, path, { line: lineOfOffset(source.full, source.start) })
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
      // Opened at the page shown, partway into its part.
      const isMidPart = source.start > (source.parts[source.part]?.start ?? 0)
      const setDraft = (draft: string) =>
        update($, view, x => ({ ...x, source: x.source && { ...x.source, draft } }))

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text bold>{baseOf(source.path)}</Text>
            {source.label !== '' && <Text>{`· ${source.label}`}</Text>}
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
            {isMidPart && (
              <Button
                key="whole"
                label={hasParts ? 'Ver a seção inteira' : 'Ver o arquivo inteiro'}
                onPress={() => {
                  if (isDirty) $.ui.toast('Salve ou descarte as mudanças antes.')
                  else void openSource($, source.path, { part: source.part })
                }}
              />
            )}
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
                else void openSource($, source.path, { part: Number(value) })
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
                onPress={() => void openSource($, source.path, { line: lineOfOffset(source.full, source.start) })}
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
      : v.status === 'installing' ? `instalando: ${v.installNote ?? ''}`
      : v.status === 'error' && (v.missingTools ?? []).length > 0 && v.errors.length === 0 ? 'faltam programas'
      : v.status === 'error' ? 'erros na compilação'
      : v.status === 'ok' ? `página ${v.page} de ${v.pages || '?'}${v.isRefining ? ' · atualizando referências…' : ''}`
      : 'aguardando um .tex'
    const svg =
      v.image &&
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v.image.width} ${v.image.height}" width="${v.image.width}" height="${v.image.height}">` +
      `<rect width="100%" height="100%" fill="#fff"/>` +
      `<image href="data:image/png;base64,${v.image.base64}" width="${v.image.width}" height="${v.image.height}"/></svg>`
    const go = (page: number) => void showPage($, page).then(() => prefetch($))
    // TinyTeX brings every tool on Windows; elsewhere the PDF tools are poppler's.
    const missing = v.missingTools ?? []
    const isWindows = v.root !== undefined && isWindowsPath(v.root)
    const lacksTex = missing.some(tool => tool === 'pdflatex' || tool === 'latexmk' || tool === 'synctex')
    const lacksPdfTools = missing.some(tool => tool.startsWith('pdfto'))
    const needsTex = lacksTex || (isWindows && lacksPdfTools)
    const needsPoppler = !isWindows && lacksPdfTools
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
          {Input && v.root && (
            <Button key="edit" label="Editar esta página" onPress={() => void openAtPage($)} />
          )}
        </Box>
        {needsTex && v.status !== 'installing' && (
          <Box flexDirection="column" gap={1}>
            <Text color="yellow">
              {`O LaTeX não foi encontrado neste computador (faltam: ${missing.join(', ')}). ` +
                'O mod pode instalar o TinyTeX, uma versão enxuta do TeX Live: ~200 MB, alguns minutos, ' +
                'na sua pasta de usuário, sem pedir permissão de administrador.'}
            </Text>
            <Button
              key="install-tex"
              variant="primary"
              label="Instalar LaTeX (TinyTeX)"
              onPress={() => later($, () => installTex($))}
            />
          </Box>
        )}
        {needsPoppler && (
          <Text color="yellow">
            {`Faltam ${missing.filter(tool => tool.startsWith('pdfto')).join(' e ')}, que vêm do poppler, não do TeX Live. ` +
              'No Mac: brew install poppler. No Linux: sudo apt install poppler-utils (ou o equivalente da sua distribuição).'}
          </Text>
        )}
        {v.missingFile && v.status !== 'installing' && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text color="yellow">{`Falta ${v.missingFile} neste computador.`}</Text>
            <Button
              key="install-package"
              label={`Instalar o pacote de ${v.missingFile}`}
              onPress={() => {
                const file = v.missingFile
                if (file) later($, () => installPackage($, file))
              }}
            />
          </Box>
        )}
        {v.installNote && v.status !== 'installing' && <Text dimColor>{v.installNote}</Text>}
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
