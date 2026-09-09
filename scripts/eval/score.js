// Score one review against a golden entry.
//   node scripts/eval/score.js <golden-id> <review.md> [more reviews...]
// Prints a markdown table (one row per must/must-not, one column per run)
// and exits 1 if any must_find is missed or any must_not_find is asserted
// in every run — the summary is meant for $GITHUB_STEP_SUMMARY.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const [id, ...files] = process.argv.slice(2)
if (!id || !files.length) {
  console.error('usage: score.js <golden-id> <review.md> [...]')
  process.exit(2)
}
const golden = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'eval', 'golden.json'), 'utf-8')).prs.find((p) => p.id === id)
if (!golden) { console.error(`no golden entry "${id}"`); process.exit(2) }

const reviews = files.map((f) => readFileSync(f, 'utf-8'))
// Findings only: the ### blocks (🔴/🟠). ⚠️/❓ sections are questions, not assertions.
const findingsOnly = (t) => [...t.matchAll(/^### \d+\. .*$\n([\s\S]*?)(?=^### |^## |\Z)/gm)].map((m) => m[0]).join('\n')
const verdict = (t) => (t.match(/\*\*Verdict\s*:\s*([^*\n]+)\*\*/) || [])[1]?.trim() || '?'
const counts = (t) => (t.match(/\*\*Compte\s*:\s*([^\n]+)\*\*/) || [])[1]?.trim() || '?'

const rows = []
let fail = false
for (const m of golden.must_find) {
  const re = new RegExp(m.pattern, 'i')
  const hits = reviews.map((r) => re.test(r))
  if (!hits.some(Boolean)) fail = true
  rows.push(['must find', m.name, ...hits.map((h) => (h ? '✅' : '❌'))])
}
for (const m of golden.must_not_find) {
  const re = new RegExp(m.pattern, 'i')
  const hits = reviews.map((r) => re.test(findingsOnly(r)))
  if (hits.some(Boolean)) fail = true
  rows.push(['must NOT assert', m.name, ...hits.map((h) => (h ? '❌ asserted' : '✅'))])
}
const runCols = files.map((_, i) => `run ${i + 1}`)
const out = []
out.push(`### Eval — ${golden.repo}#${golden.pr} (${id})`, '')
out.push(`| | | ${runCols.join(' | ')} |`, `|---|---|${runCols.map(() => '---').join('|')}|`)
for (const r of rows) out.push(`| ${r.join(' | ')} |`)
out.push('', `| | ${runCols.join(' | ')} |`, `|---|${runCols.map(() => '---').join('|')}|`)
out.push(`| verdict | ${reviews.map(verdict).join(' | ')} |`)
out.push(`| compte | ${reviews.map(counts).join(' | ')} |`)
const found = golden.must_find.filter((m) => reviews.some((r) => new RegExp(m.pattern, 'i').test(r))).length
out.push('', `**Recall (any run): ${found}/${golden.must_find.length} · ${fail ? '❌ FAIL' : '✅ PASS'}**`)
console.log(out.join('\n'))
process.exit(fail ? 1 : 0)
