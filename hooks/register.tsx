import type { ElementTable, Register, RenderNode } from 'claude-code'

// ---------------------------------------------------------------- semantics --
// The terminal's built-in markdown table renderer counts a CJK glyph as one
// cell where it takes two, so columns collapse to one glyph per line; and it
// drops a table that follows another without a blank line between them,
// spitting it out as raw `| ... |` text. This mod re-draws any AssistantMessage
// block that holds a GFM pipe table: tables get a hand-laid grid (true display
// widths, cells wrapped inside their column, header bold, inline code colored),
// and everything else in the block goes back to the surface's own Markdown
// element untouched.
//
// Streaming: ui.render runs on every partial props.text, so a table mid-parse
// would jitter (widths recomputed per arriving row, rows re-attributed when a
// second table's separator lands). A table is drawn as a grid only once it is
// settled — a non-table line followed it, another table's separator closed it,
// or the turn itself completed (turn.complete invalidates, and old tentative
// tables snap to grids at once). Until then its raw source lines stream in
// as-is: appended only, never reflowed.

type Align = 'left' | 'right' | 'center'
type Run = { text: string; code?: true; bold?: true }
type Table = { align: Align[]; header: string[]; rows: string[][]; src: string[]; settled: boolean }
type Segment = { kind: 'md'; text: string } | { kind: 'table'; table: Table }

// Borders and line characters, ported from tabled's presets (its papergrid
// holds them as pure data; the layout never reads them beyond their width).
type HLine = { dash: string; join: string; left: string; right: string }
type Borders = {
  top: HLine | null
  mid: HLine | null
  foot: HLine | null
  ver: string | null
  bodySep: boolean
}

const STYLE: Borders = {
  top: { dash: '─', join: '┬', left: '┌', right: '┐' },
  mid: { dash: '─', join: '┼', left: '├', right: '┤' },
  foot: { dash: '─', join: '┴', left: '└', right: '┘' },
  ver: '│',
  bodySep: true,
}

// The rest of tabled's palette, kept as data so a future style command is a
// name lookup. ascii/dots/markdown/blank border in pure ASCII: immune to the
// ambiguous-width trap by construction. extended keeps the pi metric too
// (box glyphs one cell); on a font that paints them wide it would drift —
// same as pi itself would.
const STYLES: Record<string, Borders> = {
  modern: STYLE,
  ascii: {
    top: { dash: '-', join: '+', left: '+', right: '+' },
    mid: { dash: '-', join: '+', left: '+', right: '+' },
    foot: { dash: '-', join: '+', left: '+', right: '+' },
    ver: '|',
    bodySep: true,
  },
  extended: {
    top: { dash: '═', join: '╦', left: '╔', right: '╗' },
    mid: { dash: '═', join: '╬', left: '╠', right: '╣' },
    foot: { dash: '═', join: '╩', left: '╚', right: '╝' },
    ver: '║',
    bodySep: true,
  },
  markdown: {
    top: null,
    mid: { dash: '-', join: '|', left: '|', right: '|' },
    foot: null,
    ver: '|',
    bodySep: false,
  },
  dots: {
    top: { dash: '.', join: '.', left: '.', right: '.' },
    mid: { dash: '.', join: ':', left: ':', right: ':' },
    foot: { dash: '.', join: ':', left: ':', right: ':' },
    ver: ':',
    bodySep: true,
  },
  blank: { top: null, mid: null, foot: null, ver: null, bodySep: false },
}
type TableLayout = {
  widths: number[]
  align: Align[]
  borders: Borders
  head: Run[][][]
  body: Run[][][][]
}

// ------------------------------------------------------------ display width --

// pi's visibleWidth, ported whole: grapheme segmentation, the same Unicode
// property classes, the same generated East Asian Width tables —
// get-east-asian-width 1.6.0's data copied as data, since a mod has no npm.
// Ambiguous glyphs (│ ┬ ┼) count 1, as pi counts them; ✅ U+2705 stands in
// the wide table, and ⚠️ counts 2 through its emoji presentation selector.
// Regexes are built in try/catch so a host without the `v` flag (or without
// Intl.Segmenter) still loads: the approximations below then take over.

const makeRe = (source: string, flags: string): RegExp | null => {
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

const zeroWidthRe = makeRe('^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Mark}|\\p{Surrogate})+$', 'u')
const leadingNonPrintingRe = makeRe(
  '^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+',
  'u',
)
const nonPrintingRe = makeRe('^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Surrogate})$', 'u')
const markRe = makeRe('^\\p{Mark}$', 'u')
const pictographicRe = makeRe('\\p{Extended_Pictographic}', 'u')
const rgiEmojiRe = makeRe('^\\p{RGI_Emoji}$', 'v')

type SegmenterLike = { segment: (s: string) => Iterable<{ segment: string }> }
const segmentGraphemes: (s: string) => string[] = (() => {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => SegmenterLike })
    .Segmenter
  if (Seg === undefined) return (s: string): string[] => Array.from(s)
  const seg = new Seg(undefined, { granularity: 'grapheme' })
  return (s: string): string[] => Array.from(seg.segment(s), x => x.segment)
})()

// flat [lo, hi, lo, hi, ...] ascending — the package's lookup-data.js
const FULLWIDTH: readonly number[] = [12288, 12288, 65281, 65376, 65504, 65510]

const WIDERAW: readonly number[] = [
  4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9776, 9783,
  9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934,
  9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024, 10024,
  10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035,
  11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350,
  12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880,
  42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126,
  65128, 65131, 94176, 94180, 94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576, 110579,
  110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948,
  110951, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374,
  127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744,
  127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984,
  127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334, 128336,
  128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716, 128716,
  128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992, 129003, 129008,
  129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129674, 129678, 129734,
  129736, 129736, 129741, 129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141,
]

const inRanges = (cp: number, ranges: readonly number[]): boolean => {
  let low = 0
  let high = ranges.length / 2 - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (cp < ranges[mid * 2]!) high = mid - 1
    else if (cp > ranges[mid * 2 + 1]!) low = mid + 1
    else return true
  }
  return false
}

const eastAsianWidth = (cp: number): number => (inRanges(cp, FULLWIDTH) || inRanges(cp, WIDERAW) ? 2 : 1)

// pi's prefilter that keeps the RGI test off ordinary clusters.
const couldBeEmoji = (segment: string): boolean => {
  const cp = segment.codePointAt(0) ?? 0
  return (
    (cp >= 0x1f000 && cp <= 0x1fbff) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b50 && cp <= 0x2b55) ||
    segment.includes('\uFE0F') ||
    segment.includes('\u200D') ||
    segment.length > 2
  )
}

const clusterWidth = (segment: string): number => {
  if (segment.length === 1) {
    const code = segment.charCodeAt(0)
    if (code >= 0x20 && code <= 0x7e) return 1
    if (code === 0x09) return 3
  }
  if (zeroWidthRe?.test(segment) === true) return 0
  if (couldBeEmoji(segment)) {
    if (rgiEmojiRe?.test(segment) === true) return 2
    if (rgiEmojiRe === null && segment.includes('\uFE0F') && pictographicRe?.test(segment) === true) return 2
  }
  const first = segment.codePointAt(0) ?? 0
  if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2 // regional pair
  const stripped = leadingNonPrintingRe ? segment.replace(leadingNonPrintingRe, '') : segment
  const cp = stripped.codePointAt(0)
  if (cp === undefined) return 0
  let width = eastAsianWidth(cp)
  const rest = stripped.slice(String.fromCodePoint(cp).length)
  for (const ch of rest) {
    if (markRe?.test(ch) === true) continue
    if (nonPrintingRe?.test(ch) === true) continue
    const c = ch.codePointAt(0)!
    if (c >= 0xff00 && c <= 0xffef) width += eastAsianWidth(c)
  }
  return width
}

const WIDTH_CACHE_SIZE = 512
const widthCache = new Map<string, number>()

const textWidth = (s: string): number => {
  let ascii = true
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) {
      ascii = false
      break
    }
  }
  if (ascii) return s.length
  const cached = widthCache.get(s)
  if (cached !== undefined) return cached
  let w = 0
  for (const cluster of segmentGraphemes(s)) w += clusterWidth(cluster)
  if (widthCache.size >= WIDTH_CACHE_SIZE) widthCache.delete(widthCache.keys().next().value as string)
  widthCache.set(s, w)
  return w
}

// -------------------------------------------------------------- inline runs --

const parseInline = (s: string): Run[] => {
  const runs: Run[] = []
  let rest = s
  while (rest.length > 0) {
    const tick = rest.indexOf('`')
    const star = rest.indexOf('**')
    const at = tick === -1 ? star : star === -1 ? tick : Math.min(tick, star)
    if (at === -1) {
      runs.push({ text: rest })
      break
    }
    const code = at === tick
    const close = rest.indexOf(code ? '`' : '**', at + (code ? 1 : 2))
    if (at > 0) runs.push({ text: rest.slice(0, at) })
    if (close === -1) {
      runs.push({ text: rest.slice(at) })
      break
    }
    runs.push(
      code
        ? { text: rest.slice(at + 1, close), code: true }
        : { text: rest.slice(at + 2, close), bold: true },
    )
    rest = rest.slice(close + (code ? 1 : 2))
  }
  return runs
}

const coalesce = (runs: Run[]): Run[] => {
  const out: Run[] = []
  for (const r of runs) {
    const last = out[out.length - 1]
    if (last !== undefined && last.code === r.code && last.bold === r.bold) last.text += r.text
    else out.push({ ...r })
  }
  return out
}

// ------------------------------------------------------------------ wrapping --

// Breakable units at grapheme granularity — pi's wrap in cluster form: space
// runs (U+3000 included) together, every wide cluster (one CJK glyph, one
// full emoji) alone, narrow clusters run-together as a word.
const splitUnits = (s: string): string[] => {
  const clusters = segmentGraphemes(s)
  const isSpace = (c: string): boolean => c === ' ' || c === '　'
  const units: string[] = []
  let i = 0
  while (i < clusters.length) {
    const c = clusters[i]!
    if (isSpace(c)) {
      let j = i
      while (j < clusters.length && isSpace(clusters[j]!)) j++
      units.push(clusters.slice(i, j).join(''))
      i = j
    } else if (clusterWidth(c) === 2) {
      units.push(c)
      i++
    } else {
      let j = i
      while (j < clusters.length && !isSpace(clusters[j]!) && clusterWidth(clusters[j]!) < 2) j++
      units.push(clusters.slice(i, j).join(''))
      i = j
    }
  }
  return units
}

const splitHard = (unit: string, w: number): string[] => {
  const pieces: string[] = []
  let cur = ''
  let cw = 0
  for (const cluster of segmentGraphemes(unit)) {
    const cwd = clusterWidth(cluster)
    if (cw + cwd > w && cur !== '') {
      pieces.push(cur)
      cur = ''
      cw = 0
    }
    cur += cluster
    cw += cwd
  }
  if (cur !== '') pieces.push(cur)
  return pieces
}

const wrapRuns = (runs: Run[], w: number): Run[][] => {
  const lines: Run[][] = []
  let cur: Run[] = []
  let curW = 0
  const flush = () => {
    lines.push(coalesce(cur))
    cur = []
    curW = 0
  }
  for (const run of runs) {
    for (const unit of splitUnits(run.text)) {
      const uw = textWidth(unit)
      const space = unit.trim() === ''
      if (curW + uw <= w) {
        if (space && curW === 0) continue
        cur.push({ text: unit, code: run.code, bold: run.bold })
        curW += uw
      } else if (space) {
        if (curW > 0) flush()
      } else if (uw > w) {
        for (const piece of splitHard(unit, w)) {
          const pw = textWidth(piece)
          if (curW + pw > w && curW > 0) flush()
          cur.push({ text: piece, code: run.code, bold: run.bold })
          curW += pw
        }
      } else {
        flush()
        cur.push({ text: unit, code: run.code, bold: run.bold })
        curW = uw
      }
    }
  }
  if (curW > 0) flush()
  return lines.length > 0 ? lines : [[]]
}

// ------------------------------------------------------------------ parsing --

const isFence = (line: string): boolean => /^\s{0,3}(```|~~~)/.test(line)
const isRow = (line: string): boolean => line.includes('|') && !isFence(line)
const isSeparator = (line: string): boolean => {
  const t = line.trim()
  return t.includes('|') && t.includes('-') && /^[-:| ]+$/.test(t)
}

const splitRow = (line: string): string[] => {
  const cells = line
    .trim()
    .replace(/\\\|/g, '\x00')
    .split('|')
    .map(c => c.trim().replace(/\x00/g, '|'))
  if (cells.length > 0 && cells[0] === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  return cells
}

const parseAlign = (sep: string): Align[] =>
  splitRow(sep).map(c =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  )

function padTo<T>(a: T[], n: number, fill: T): T[] {
  if (a.length >= n) return a.slice(0, n)
  return [...a, ...Array<T>(n - a.length).fill(fill)]
}

// Null when the block holds no table. A separator met mid-body closes the
// table and reopens it on the row above: two tables with no blank line
// between them (what the engine's parser chokes on) render as two grids.
const segmentBlocks = (text: string): Segment[] | null => {
  const lines = text.split('\n')
  const out: Segment[] = []
  let md: string[] = []
  let fence = false
  let found = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isFence(line)) {
      fence = !fence
      md.push(line)
      i++
      continue
    }
    if (!fence && i + 1 < lines.length && isRow(line) && isSeparator(lines[i + 1]!)) {
      const align = parseAlign(lines[i + 1]!)
      const header = splitRow(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && !isFence(lines[j]!) && isRow(lines[j]!)) {
        if (isSeparator(lines[j]!)) {
          if (rows.length > 0) {
            rows.pop() // that row is the next table's header
            j--
          }
          break
        }
        rows.push(splitRow(lines[j]!))
        j++
      }
      // A table running to the block's end may still grow: unsettled.
      out.push(
        { kind: 'md', text: md.join('\n') },
        {
          kind: 'table',
          table: { align, header, rows, src: lines.slice(i, j), settled: j < lines.length },
        },
      )
      md = []
      found = true
      i = j
      continue
    }
    md.push(line)
    i++
  }
  if (!found) return null
  out.push({ kind: 'md', text: md.join('\n') })
  return out
}

// ------------------------------------------------------------------ layout --

// pi's renderTable allocation, ported: every column knows its natural width
// and the width of its longest unbreakable unit (a Latin word, or one CJK
// glyph — finer than pi's whitespace split, which would treat a whole CJK
// phrase as one word; capped at pi's 30). Everything natural fits → take it.
// Otherwise every column lands on its unit minimum and the leftover cells
// are shared out in proportion to how much each column could still grow,
// the rounding remainders dealt out left to right. Where even the minimum
// does not fit, pi's weighted base-1 fallback allocates instead. Never
// truncates: too-narrow content wraps, exactly like pi.
const MAX_UNBROKEN = 30

const longestUnit = (runs: Run[]): number => {
  let m = 1
  for (const r of runs) {
    for (const u of splitUnits(r.text)) {
      const w = textWidth(u)
      if (w > m) m = w
    }
  }
  return Math.min(m, MAX_UNBROKEN)
}

const layoutTable = (table: Table, budget: number): TableLayout | null => {
  const cols = Math.max(table.header.length, table.align.length)
  if (cols === 0) return null
  const overhead = (STYLE.ver === null ? 0 : cols + 1) + 2 * cols // seams + one pad each side
  const forCells = budget - overhead
  if (forCells < cols) return null // cannot even seat one cell per column
  const natural: number[] = []
  const minimum: number[] = []
  for (let i = 0; i < cols; i++) {
    let nat = 1
    let min = 1
    for (const r of [table.header, ...table.rows]) {
      const runs = parseInline(r[i] ?? '')
      const w = runs.reduce((s, x) => s + textWidth(x.text), 0)
      if (w > nat) nat = w
      const u = longestUnit(runs)
      if (u > min) min = u
    }
    natural.push(nat)
    minimum.push(Math.min(min, forCells))
  }
  let widths = natural.slice()
  if (natural.reduce((a, w) => a + w, 0) > forCells) {
    const minSum = minimum.reduce((a, w) => a + w, 0)
    if (minSum > forCells) {
      const weights = minimum.map(w => Math.max(0, w - 1))
      const total = weights.reduce((a, w) => a + w, 0)
      const remaining = forCells - cols
      widths = weights.map(w => 1 + (total > 0 ? Math.floor((w / total) * remaining) : 0))
      let dealt = widths.reduce((a, w) => a + w - 1, 0)
      for (let i = 0; i < cols && dealt < remaining; i++, dealt++) widths[i] = widths[i]! + 1
    } else {
      const extra = forCells - minSum
      const potential = natural.reduce((t, w, i) => t + Math.max(0, w - minimum[i]!), 0)
      widths = minimum.map((m, i) => {
        const room = Math.max(0, natural[i]! - m)
        return m + (potential > 0 ? Math.floor((room / potential) * extra) : 0)
      })
      let left = forCells - widths.reduce((a, w) => a + w, 0)
      let grew = true
      while (left > 0 && grew) {
        grew = false
        for (let i = 0; i < cols && left > 0; i++) {
          if (widths[i]! < natural[i]!) {
            widths[i] = widths[i]! + 1
            left--
            grew = true
          }
        }
      }
    }
  }
  const align = padTo(table.align, cols, 'left')
  const wrap = (cells: string[]): Run[][][] =>
    padTo(cells, cols, '')
      .slice(0, cols)
      .map((c, i) => wrapRuns(parseInline(c), widths[i]!))
  return { widths, align, borders: STYLE, head: wrap(table.header), body: table.rows.map(wrap) }
}

// ------------------------------------------------------------------ drawing --

// No borderStyle: a bordered Box stretches to the message's full width under
// this transcript's flex layout, so its frame spans the screen and the table
// floats in the corner of it. The grid is hand-laid instead, pi's way: an
// unstyled row is one whole string — seams and padding baked in, nothing for
// the surface to re-measure — and only rows holding styled runs become Text
// fragments, padded from the same pi-ported widths. Rules are the same
// strings pi pushes: one plain-color line, uniform with the row seams.
const paintTable = (ui: ElementTable, t: TableLayout) => {
  const { Box, Text } = ui
  const b = t.borders
  const seam = (): RenderNode[] => (b.ver === null ? [] : [<Text>{b.ver}</Text>])
  // Named `line`, not `h`: the JSX factory is the global `h`, and shadowing it
  // inside a function holding JSX turns the transpiled `h(...)` into the data.
  const hline = (line: HLine | null) =>
    line === null
      ? null
      : <Text>{line.left + t.widths.map(w => line.dash.repeat(w + 2)).join(line.join) + line.right}</Text>
  const row = (cells: Run[][][], bold: boolean) => {
    const height = Math.max(1, ...cells.map(c => c.length))
    const lines: RenderNode[] = []
    for (let ln = 0; ln < height; ln++) {
      const parts: string[] = []
      let plain = !bold
      cells.forEach((cell, i) => {
        const w = t.widths[i] ?? 1
        const align = t.align[i] ?? 'left'
        const runs = cell[ln] ?? []
        if (runs.some(r => r.code === true || r.bold === true)) plain = false
        const text = runs.map(r => r.text).join('')
        const pad = Math.max(0, w - textWidth(text))
        const left = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0
        parts.push(' '.repeat(left + 1) + text + ' '.repeat(pad - left + 1))
      })
      if (plain) {
        const lineStr = b.ver === null ? parts.join('') : b.ver + parts.join(b.ver) + b.ver
        lines.push(<Text>{lineStr}</Text>)
        continue
      }
      const kids: RenderNode[] = [...seam()]
      cells.forEach((cell, i) => {
        const w = t.widths[i] ?? 1
        const align = t.align[i] ?? 'left'
        const runs = cell[ln] ?? []
        const runW = runs.reduce((s, r) => s + textWidth(r.text), 0)
        const pad = Math.max(0, w - runW)
        const left = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0
        kids.push(' '.repeat(left + 1))
        for (const r of runs) {
          kids.push(
            <Text
              {...(bold || r.bold === true ? { weight: 'bold' as const } : {})}
              {...(r.code === true ? { color: 'suggestion' as const } : {})}
            >
              {r.text}
            </Text>,
          )
        }
        kids.push(' '.repeat(pad - left + 1))
        kids.push(...seam())
      })
      lines.push(<Box>{kids}</Box>)
    }
    return <Box flexDirection="column">{lines}</Box>
  }
  return (
    <Box flexDirection="column" alignItems="flex-start" marginTop={1}>
      {hline(b.top)}
      {row(t.head, true)}
      {hline(b.mid)}
      {t.body.flatMap((cells, k) =>
        b.bodySep && k > 0 ? [hline(b.mid), row(cells, false)] : [row(cells, false)],
      )}
      {hline(b.foot)}
    </Box>
  )
}

// ------------------------------------------------------------------ register --

// The flag lives in `$.state` so a reload mid-stream keeps it; a `get` made
// while drawing subscribes the instance, so the `set` false at turn end
// re-draws every tentative table as its grid — nobody calls invalidate.
const OPEN = { plugin: 'md-tables', key: 'openTurn' } as const

const paintRaw = (ui: ElementTable, lines: string[]) => {
  const { Box, Text } = ui

  return (
    <Box flexDirection="column" alignItems="flex-start" marginTop={1}>
      {lines.map(line => <Text>{line === '' ? ' ' : line}</Text>)}
    </Box>
  )
}

export const register: Register = on => {
  on('turn.start', async ($, e, next) => {
    await $.state.set(OPEN, true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await $.state.set(OPEN, false)

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true) return next(e)
    const segments = segmentBlocks(e.props.text)
    if (segments === null) return next(e)
    const { value: openTurn = false } = await $.state.get(OPEN)
    const budget = Math.max(10, (e.viewport?.columns ?? 80) - 3)
    const ui = $.ui.resolve(e)
    const { Box, Markdown } = ui
    const parts: ({ md: string } | { table: TableLayout } | { raw: string[] })[] = []
    for (const seg of segments) {
      if (seg.kind === 'md') {
        const text = seg.text.replace(/^\n+/, '').replace(/\n+$/, '')
        if (text !== '') parts.push({ md: text })
      } else if (!seg.table.settled && openTurn) {
        // still growing: stream its source lines as they are, append-only
        parts.push({ raw: seg.table.src })
      } else {
        const layout = layoutTable(seg.table, budget)
        if (layout === null) {
          // pi's own fallback: too narrow for one cell per column — keep the
          // source lines on screen rather than hand the table to the engine.
          parts.push({ raw: seg.table.src })
        } else parts.push({ table: layout })
      }
    }
    return (
      <Box flexDirection="column">
        {parts.map(part =>
          'md' in part
            ? <Markdown text={part.md} />
            : 'raw' in part
              ? paintRaw(ui, part.raw)
              : paintTable(ui, part.table),
        )}
      </Box>
    )
  })
}
