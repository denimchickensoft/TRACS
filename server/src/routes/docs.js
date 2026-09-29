'use strict'

const fs = require('fs')
const path = require('path')
const { Marked } = require('marked')

// GitHub's heading-slug algorithm (marked no longer generates heading ids by
// default as of v5+): lowercase, drop anything but letters/digits/space/-,
// each space -> one hyphen (runs are not collapsed, so "A & B" gives "a--b"),
// dedupe repeats with a -1, -2, ... suffix.
function makeSlugger() {
  const seen = new Map()
  return (raw) => {
    const base = raw.toLowerCase().replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}

// Reset per-document in the route handler so slug dedup counts don't leak
// between different pages served by this same shared instance.
let slugify = makeSlugger()

// Renderer overrides receive the token (marked 13+): `text` is the heading's
// raw source for the slug, `tokens` its inline content to render.
const marked = new Marked({
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slugify(text)}">${this.parser.parseInline(tokens)}</h${depth}>`
    },
  },
})

const DOCS_DIR = path.join(__dirname, '../../../docs')
const REPO_ROOT = path.join(__dirname, '../../..')

// Whitelist doubles as the path-traversal guard — req.params.page can only
// ever resolve to one of these on-disk files.
const DOCS_PAGES = new Set(['index', 'getting-started', 'atc', 'catcc', 'aic', 'abm'])

// Legal files live at the repo root (where GitHub and the installer expect
// them) but are also served here so the About section's links work offline.
// `plain` files are shown preformatted rather than rendered as markdown.
const ROOT_PAGES = {
  'license':             { file: 'LICENSE', plain: true, title: 'TRACS License' },
  'third-party-notices': { file: 'THIRD_PARTY_NOTICES.md', plain: false, title: 'TRACS Third-Party Notices' },
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Relative links in the source markdown become /docs/* routes: cross-doc
// links (e.g. "atc.md") and links from docs/ up to the root legal files
// (e.g. "../THIRD_PARTY_NOTICES.md", or "LICENSE" from the notices file itself).
function rewriteLinks(markdown) {
  return markdown
    .replace(/\]\((?:\.\.\/)?LICENSE\)/g, '](/docs/license)')
    .replace(/\]\((?:\.\.\/)?THIRD_PARTY_NOTICES\.md\)/g, '](/docs/third-party-notices)')
    .replace(/\]\((?!https?:|#)([a-z-]+)\.md/g, '](/docs/$1')
}

function renderPage(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${PAGE_STYLE}</style>
<script src="/docs/assets/find.js" defer></script>
</head>
<body>${body}</body>
</html>`
}

const PAGE_STYLE = `
  body { background: #111; color: #ccc; font-family: -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.6; max-width: 860px; margin: 0 auto; padding: 24px 32px 64px; }
  h1, h2, h3 { color: #eee; border-bottom: 1px solid #333; padding-bottom: 6px; }
  a { color: #6cf; }
  code { background: #1a1a1a; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #1a1a1a; padding: 12px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #333; padding: 4px 10px; }
  blockquote { border-left: 3px solid #444; margin-left: 0; padding-left: 14px; color: #999; }
  img { max-width: 100%; height: auto; }
`

// Registers TRACS's own local operator docs — GET /docs/:page — so the
// settings gear's "Help / Docs" link works without internet access on a
// LAN/offline DCS setup. Renders docs/<page>.md as styled HTML rather than
// dumping raw markdown.
function registerDocsRoutes(app) {
  // The desktop app's Ctrl+F box (see docsFind.js). A separate file, not an
  // inline script, so the Content-Security-Policy allows it.
  app.get('/docs/assets/find.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(__dirname, '../docsFind.js'))
  })

  // Screenshots referenced from the docs as "images/<name>", which resolves
  // here from a /docs/<page> URL and to docs/images/ on GitHub. The filename
  // pattern keeps the lookup inside docs/images.
  app.get('/docs/images/:file', (req, res) => {
    if (!/^[a-z0-9-]+\.(png|jpg|webp)$/.test(req.params.file)) return res.status(404).send('Not found')
    res.sendFile(path.join(DOCS_DIR, 'images', req.params.file), (err) => {
      if (err && !res.headersSent) res.status(404).send('Not found')
    })
  })

  app.get('/docs/:page', (req, res) => {
    const page = req.params.page.replace(/\.md$/, '')

    const rootPage = Object.hasOwn(ROOT_PAGES, page) ? ROOT_PAGES[page] : null
    if (rootPage) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rootPage.file), 'utf8')
      slugify = makeSlugger()
      const body = rootPage.plain ? `<pre>${escapeHtml(text)}</pre>` : marked.parse(rewriteLinks(text))
      return res.send(renderPage(rootPage.title, body))
    }

    if (!DOCS_PAGES.has(page)) return res.status(404).send('Not found')

    const filePath = path.join(DOCS_DIR, `${page}.md`)
    const markdown = fs.readFileSync(filePath, 'utf8')
    slugify = makeSlugger()
    res.send(renderPage('TRACS Docs', marked.parse(rewriteLinks(markdown))))
  })
}

module.exports = { registerDocsRoutes, makeSlugger }
