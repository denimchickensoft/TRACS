'use strict'

const fs = require('fs')
const path = require('path')
const { Marked } = require('marked')

// GitHub's heading-slug algorithm (marked no longer generates heading ids by
// default as of v5+): lowercase, drop anything but letters/digits/space/-,
// spaces -> hyphens, dedupe repeats with a -1, -2, ... suffix.
function makeSlugger() {
  const seen = new Map()
  return (raw) => {
    const base = raw.toLowerCase().replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}

// Reset per-document in the route handler so slug dedup counts don't leak
// between different pages served by this same shared instance.
let slugify = makeSlugger()

const marked = new Marked({
  renderer: {
    heading(text, level, raw) {
      return `<h${level} id="${slugify(raw)}">${text}</h${level}>`
    },
  },
})

const DOCS_DIR = path.join(__dirname, '../../../docs')

// Whitelist doubles as the path-traversal guard — req.params.page can only
// ever resolve to one of these on-disk files.
const DOCS_PAGES = new Set(['index', 'getting-started', 'atc', 'catcc', 'aic', 'abm'])

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
`

// Registers TRACS's own local operator docs — GET /docs/:page — so the
// settings gear's "Help / Docs" link works without internet access on a
// LAN/offline DCS setup. Renders docs/<page>.md as styled HTML rather than
// dumping raw markdown.
function registerDocsRoutes(app) {
  app.get('/docs/:page', (req, res) => {
    const page = req.params.page.replace(/\.md$/, '')
    if (!DOCS_PAGES.has(page)) return res.status(404).send('Not found')

    const filePath = path.join(DOCS_DIR, `${page}.md`)
    const markdown = fs.readFileSync(filePath, 'utf8')
    slugify = makeSlugger()
    // Cross-doc links in the source are relative .md paths (e.g. "atc.md") —
    // rewrite them to this route so they resolve when served from /docs/*.
    const html = marked.parse(markdown.replace(/\]\((?!https?:|#)([a-z-]+)\.md/g, '](/docs/$1'))

    res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>TRACS Docs</title>
<style>${PAGE_STYLE}</style>
</head>
<body>${html}</body>
</html>`)
  })
}

module.exports = { registerDocsRoutes }
