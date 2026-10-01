/* eslint-env node */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { loadKatexFonts } from '../../../src/components/MarkdownRender/katex-fonts.mjs'

const glyph = (family, text = 'x', style = 'normal', weight = '400') =>
  `<span style="font-family: ${family}; font-style: ${style}; font-weight: ${weight}">${text}</span>`
const simpleMath = glyph('KaTeX_Math', 'x', 'italic') + glyph('KaTeX_Main', '+1')

function fixture(t, html = simpleMath, options = {}) {
  const dom = new JSDOM(
    `<span class="katex"><span class="katex-mathml">${glyph(
      'KaTeX_AMS',
    )}</span><span class="katex-html">${html}</span></span>`,
    { url: options.url || 'https://example.com' },
  )
  t.after(() => dom.window.close())
  const document = dom.window.document
  const root = document.querySelector('.katex')
  const requests = []
  const registered = []
  const warnings = []
  Object.defineProperty(document, 'fonts', { value: { add: (font) => registered.push(font) } })
  t.mock.method(globalThis, 'fetch', async (url) => {
    const filename = url.split('/').at(-1)
    requests.push(filename)
    if (options.fetch) await options.fetch(filename)
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }
  })
  const originalFontFace = Object.getOwnPropertyDescriptor(globalThis, 'FontFace')
  globalThis.FontFace = class {
    constructor(family, source, descriptors) {
      this.family = family
      this.source = source
      Object.assign(this, descriptors)
    }
    async load() {
      if (options.load) await options.load(this)
      return this
    }
  }
  t.after(() => {
    if (originalFontFace) Object.defineProperty(globalThis, 'FontFace', originalFontFace)
    else delete globalThis.FontFace
  })
  t.mock.method(console, 'warn', (...args) => warnings.push(args))
  return { root, document, requests, registered, warnings }
}

test('plain content and MathML-only output do not request fonts', async (t) => {
  const f = fixture(t)
  await loadKatexFonts(f.document.createElement('span'))
  f.root.querySelector('.katex-html').remove()
  await loadKatexFonts(f.root)
  assert.deepEqual(f.requests, [])
})

test('simple math loads only the two visible faces, cached across renders', async (t) => {
  const f = fixture(t, simpleMath + glyph('KaTeX_Main', '=2'))
  await loadKatexFonts(f.root)
  await loadKatexFonts(f.root)
  assert.deepEqual(f.requests.sort(), ['KaTeX_Main-Regular.woff2', 'KaTeX_Math-Italic.woff2'])
  assert.equal(f.registered.length, 2)
  assert.ok(f.registered.every((font) => font.source instanceof ArrayBuffer))
})

test('changed math adds new faces without fetching successful faces again', async (t) => {
  const f = fixture(t)
  await loadKatexFonts(f.root)
  f.root.querySelector('.katex-html').innerHTML =
    simpleMath + glyph('KaTeX_Size2', '∑') + glyph('KaTeX_Main', 'y', 'italic', '700')
  await loadKatexFonts(f.root)
  assert.deepEqual(f.requests.slice(2).sort(), [
    'KaTeX_Main-BoldItalic.woff2',
    'KaTeX_Size2-Regular.woff2',
  ])
  assert.equal(f.registered.length, 4)
})

test('concurrent formulas deduplicate requests and register a fast face immediately', async (t) => {
  let finishSlowFont
  let fastFontAdded
  const slowFont = new Promise((resolve) => (finishSlowFont = resolve))
  const fastFont = new Promise((resolve) => (fastFontAdded = resolve))
  const f = fixture(t, simpleMath, {
    load: async (font) => {
      if (font.family === 'KaTeX_Math') await slowFont
    },
  })
  const originalAdd = f.document.fonts.add
  f.document.fonts.add = (font) => {
    originalAdd(font)
    if (font.family === 'KaTeX_Main') fastFontAdded()
  }
  const first = loadKatexFonts(f.root)
  const second = loadKatexFonts(f.root)
  await fastFont
  assert.deepEqual(
    f.registered.map((font) => font.family),
    ['KaTeX_Main'],
  )
  assert.equal(f.requests.length, 2)
  finishSlowFont()
  await Promise.all([first, second])
  assert.equal(f.registered.length, 2)
})

test('a transient fetch failure retries the failed face without another render', async (t) => {
  let failed = false
  const f = fixture(t, simpleMath, {
    fetch: async (filename) => {
      if (filename === 'KaTeX_Math-Italic.woff2' && !failed) {
        failed = true
        throw new Error('Transient fetch failure')
      }
    },
  })
  await loadKatexFonts(f.root)
  assert.equal(f.requests.filter((name) => name === 'KaTeX_Main-Regular.woff2').length, 1)
  assert.equal(f.requests.filter((name) => name === 'KaTeX_Math-Italic.woff2').length, 2)
  assert.equal(f.registered.length, 2)
  assert.deepEqual(f.warnings, [])
})

test('a failed decode has bounded retries and does not block other faces or future recovery', async (t) => {
  let fail = true
  const f = fixture(t, simpleMath, {
    load: async (font) => {
      if (font.family === 'KaTeX_Math' && fail) throw new Error('Decode failed')
    },
  })
  await loadKatexFonts(f.root)
  assert.equal(f.requests.length, 3)
  assert.deepEqual(
    f.registered.map((font) => font.family),
    ['KaTeX_Main'],
  )
  assert.equal(f.warnings.length, 1)
  fail = false
  await loadKatexFonts(f.root)
  assert.equal(f.requests.length, 4)
  assert.equal(f.registered.length, 2)
})

test('face matching handles quoted families, bold italic and synthetic styles', async (t) => {
  const f = fixture(
    t,
    glyph("'KaTeX_Main', serif", 'x', 'italic', '700') +
      glyph('KaTeX_Script', 'y', 'italic', '700') +
      glyph('KaTeX_Math', 'z') +
      glyph('serif', 'plain'),
  )
  await loadKatexFonts(f.root)
  assert.deepEqual(f.requests.sort(), [
    'KaTeX_Main-BoldItalic.woff2',
    'KaTeX_Math-Italic.woff2',
    'KaTeX_Script-Regular.woff2',
  ])
})

test('extension pages attach one stylesheet and keep native per-face loading', async (t) => {
  const f = fixture(t, simpleMath, { url: 'chrome-extension://test/popup.html' })
  await loadKatexFonts(f.root)
  await loadKatexFonts(f.root)
  const links = f.document.querySelectorAll('#chatgptbox-katex-fonts')
  assert.equal(links.length, 1)
  assert.ok(links[0].href.endsWith('/katex-fonts.css'))
  assert.deepEqual(f.requests, [])
})
