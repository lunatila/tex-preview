import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TexPreviewPage, TexPreviewView } from '../types'

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
  const text = await readText(edit.file, $)
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

// The pages either side of the one shown, so paging through is instant.
async function prefetch($: EngineInterface) {
  const { pdf, page, pages: count } = await read($, view)
  if (pdf === undefined) return
  for (const near of [page + 1, page - 1]) {
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
  } finally {
    isRunning = false
  }
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
    void $.ui.open({ id: PANE, title: `PDF · ${baseOf(roots.get(slash(file)) ?? file)}` })
    schedule($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The terminal draws no Svg; it gets the PDF's path instead.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const v = await read($, view)
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

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text bold>{v.root ? baseOf(v.root) : 'LaTeX'}</Text>
          <Text dimColor={v.status !== 'error'} color={v.status === 'error' ? 'red' : undefined}>
            {label}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="prev" label="◀" onPress={() => void showPage($, v.page - 1).then(() => prefetch($))} />
          <Button key="next" label="▶" onPress={() => void showPage($, v.page + 1).then(() => prefetch($))} />
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
