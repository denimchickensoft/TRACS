'use strict'

// Dev tool: compares frame-meter files (relay exporter.frameMeter, see
// frameMeter.js) side by side - one column per run, over the same mission
// time window, so runs with different exporters on the same mission can be
// compared.
//
//   node scripts/frameMeterReport.js [--from <s>] [--to <s>] [--bucket <s>] <name>=<file> ...
//
//   --from/--to  mission-time window in seconds (default: everything)
//   --bucket     also print the 99th percentile per this many seconds of
//                mission time, to show how a run changes as the mission goes on
//   name=file    a column label and its .jsonl file (a bare file uses its name)

const fs   = require('fs')
const path = require('path')

function parseArgs(argv) {
  const opts = { from: -Infinity, to: Infinity, bucket: 0, runs: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from' || a === '--to' || a === '--bucket') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n)) throw new Error(`${a} needs a number of seconds`)
      opts[a.slice(2)] = n
    } else {
      const eq = a.indexOf('=')
      const file = eq > 0 ? a.slice(eq + 1) : a
      opts.runs.push({ name: eq > 0 ? a.slice(0, eq) : path.basename(file, '.jsonl'), file })
    }
  }
  if (!opts.runs.length) throw new Error('no frame-meter files given')
  return opts
}

function readRun(file) {
  const seconds = []
  let mission = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.mission) mission = rec.mission
    else if (Array.isArray(rec.frameMs) && Number.isFinite(rec.t)) seconds.push(rec)
  }
  return { mission, seconds }
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}

function summarize(seconds) {
  const frames = seconds.flatMap((s) => s.frameMs).sort((a, b) => a - b)
  const total = frames.reduce((sum, ms) => sum + ms, 0)
  const ours = seconds.reduce((sum, s) => sum + (s.ourMs ?? 0), 0)
  const span = seconds.length ? seconds[seconds.length - 1].t - seconds[0].t : 0
  return {
    'mission time': seconds.length ? `${seconds[0].t.toFixed(0)}-${seconds[seconds.length - 1].t.toFixed(0)} s` : '-',
    seconds: seconds.length,
    frames: frames.length,
    'avg fps': span > 0 ? (frames.length / (total / 1000)).toFixed(1) : '-',
    'avg ms': frames.length ? (total / frames.length).toFixed(2) : '-',
    'p50 ms': percentile(frames, 0.5).toFixed(2),
    'p95 ms': percentile(frames, 0.95).toFixed(2),
    'p99 ms': percentile(frames, 0.99).toFixed(2),
    'p99.9 ms': percentile(frames, 0.999).toFixed(2),
    'max ms': frames.length ? frames[frames.length - 1].toFixed(2) : '-',
    '> 30 ms': frames.filter((ms) => ms > 30).length,
    '> 50 ms': frames.filter((ms) => ms > 50).length,
    'TRACS exporter ms': ours.toFixed(1),
    'TRACS exporter %': total > 0 ? `${((ours / total) * 100).toFixed(2)}%` : '-',
  }
}

function table(header, rows) {
  const widths = header.map((h, c) => Math.max(String(h).length, ...rows.map((r) => String(r[c]).length)))
  const line = (cells) => cells.map((v, c) => (c === 0 ? String(v).padEnd(widths[c]) : String(v).padStart(widths[c]))).join('  ')
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

function main() {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (err) {
    console.error(`${err.message}\nusage: node scripts/frameMeterReport.js [--from <s>] [--to <s>] [--bucket <s>] <name>=<file> ...`)
    process.exit(1)
  }
  const runs = opts.runs.map((r) => {
    const { mission, seconds } = readRun(r.file)
    return { ...r, mission, seconds: seconds.filter((s) => s.t >= opts.from && s.t < opts.to) }
  })

  for (const r of runs) {
    const m = r.mission
    console.log(`${r.name}: ${r.file}${m ? ` (${m.side ?? '?'}, ${m.theatre ?? '?'}, ${m.missionFile ? path.basename(m.missionFile) : 'no mission file'}, ${m.startedAt})` : ''}`)
  }
  console.log()

  const sums = runs.map((r) => summarize(r.seconds))
  const keys = Object.keys(sums[0])
  console.log(table(['', ...runs.map((r) => r.name)], keys.map((k) => [k, ...sums.map((s) => s[k])])))

  if (opts.bucket > 0) {
    const buckets = new Map()
    runs.forEach((r, i) => {
      for (const s of r.seconds) {
        const b = Math.floor(s.t / opts.bucket) * opts.bucket
        if (!buckets.has(b)) buckets.set(b, runs.map(() => []))
        buckets.get(b)[i].push(...s.frameMs)
      }
    })
    const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, perRun]) => [
      `${b}-${b + opts.bucket} s`,
      ...perRun.map((f) => (f.length ? percentile(f.sort((x, y) => x - y), 0.99).toFixed(2) : '-')),
    ])
    console.log(`\np99 frame ms per ${opts.bucket} s of mission time`)
    console.log(table(['mission time', ...runs.map((r) => r.name)], rows))
  }
}

main()
