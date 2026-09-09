import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Deterministic pre-pass over a checked-out PR branch. Everything here is
// computed by code — same PR, same facts, every run — and handed to the model
// as its agenda. The model's job is to ASSESS these facts (intended change or
// collateral breakage? destructive or harmless?), not to rediscover them by
// grepping in a loop, which is where run-to-run variance came from.

const APP_HOOK_RE = /hulkapps|jdgm|judgeme|judge\.me|klaviyo|loox|yotpo|rebuy|gorgias|okendo|stamped|trustpilot|alma|intelligems|depict|gempages|gem-|shopify-section-group|recharge|skio|seal-subscriptions|appstle|bold/i
const SECRET_RE = /shpat_[a-z0-9]{8,}|shpss_[a-z0-9]{8,}|sk_(?:live|test)_[a-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{20,}/i

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64_000_000 })
  } catch (err) {
    if (err.status === 1 && /grep/.test(args[0])) return ''
    throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${err.stderr?.slice(0, 200) ?? err.message}`)
  }
}

function fileAt(cwd, ref, p) {
  try {
    return execFileSync('git', ['show', `${ref}:${p}`], { cwd, encoding: 'utf-8', maxBuffer: 64_000_000 })
  } catch {
    return null
  }
}

function flatten(obj, prefix = '', out = {}) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  } else {
    out[prefix] = Array.isArray(obj) ? JSON.stringify(obj) : obj
  }
  return out
}

function short(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s == null ? 'null' : s.length > 80 ? s.slice(0, 77) + '…' : s
}

function stripJsonBanner(s) {
  return s.replace(/^\s*\/\*[\s\S]*?\*\//, '')
}

export function buildReviewFacts(repoDir, baseRef = 'origin/main') {
  repoDir = path.resolve(repoDir)
  const base = git(repoDir, 'merge-base', baseRef, 'HEAD').trim()
  const facts = { base, baseRef }

  // ── 1. Files: added / modified / deleted vs the merge-base ─────────────────
  const status = git(repoDir, 'diff', '--name-status', base, 'HEAD')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [s, ...rest] = l.split('\t')
      return { status: s[0], path: rest[rest.length - 1] }
    })
  facts.files = status
  facts.themeLiquidTouched = status.some((f) => /(^|\/)layout\/theme\.liquid$/.test(f.path))
  facts.mainAheadBy = Number(git(repoDir, 'rev-list', '--count', `HEAD..${baseRef}`).trim())

  // ── 2a. JSON validity — every changed .json, schemas included: an invalid
  // component schema breaks the Hover CLI build, an invalid template breaks
  // the editor.
  facts.invalidJson = []
  for (const f of status) {
    if (!f.path.endsWith('.json') || f.status === 'D') continue
    try { JSON.parse(stripJsonBanner(fileAt(repoDir, 'HEAD', f.path) ?? '')) } catch (e) { facts.invalidJson.push({ path: f.path, error: String(e.message).slice(0, 80) }) }
  }

  // ── 2b. Key-level diffs for merchant DATA JSON (templates, settings, groups) ─
  facts.jsonDiffs = []
  for (const f of status) {
    if (!f.path.endsWith('.json') || f.status === 'D') continue
    if (!/(^|\/)(templates|config|sections)\//.test(f.path)) continue // data JSON only; component schemas are code
    let before = {}
    let after = {}
    try {
      const b = fileAt(repoDir, base, f.path)
      before = b ? flatten(JSON.parse(stripJsonBanner(b))) : {}
      after = flatten(JSON.parse(stripJsonBanner(fileAt(repoDir, 'HEAD', f.path) ?? '{}')))
    } catch {
      continue // already reported under invalidJson
    }
    const changes = []
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(k in before)) changes.push(`+ ${k} = ${short(after[k])}`)
      else if (!(k in after)) changes.push(`- ${k} (était ${short(before[k])})`)
      else if (before[k] !== after[k]) changes.push(`~ ${k}: ${short(before[k])} → ${short(after[k])}`)
    }
    if (changes.length) facts.jsonDiffs.push({ path: f.path, changes: changes.slice(0, 40), total: changes.length })
  }

  // ── 3. Deleted lines → identifiers → still referenced on HEAD? ─────────────
  const diffU0 = git(repoDir, 'diff', '-U0', base, 'HEAD')
  const deleted = []
  let cur = null
  for (const line of diffU0.split('\n')) {
    if (line.startsWith('--- a/')) cur = line.slice(6)
    else if (line.startsWith('+++ b/')) cur = line.slice(6)
    else if (line.startsWith('-') && !line.startsWith('---') && cur) deleted.push({ file: cur, text: line.slice(1) })
  }
  facts.deletedLineCount = deleted.length

  const idRe = [
    /data-[a-z][\w-]*/g, // data attributes
    /\bid="([\w-]+)"/g, // ids
    /<([a-z][a-z0-9]*-[a-z0-9-]+)[\s>]/g, // custom element tags
    /(?:section|block|settings)\.settings\.([\w]+)/g, // settings
    /render\s+['"]([\w-]+)['"]/g, // snippets
    /['"]([\w]+(?:\.[\w]+){1,4})['"]\s*\|\s*t\b/g, // locale keys
    /customElements\.define\(\s*['"]([\w-]+)['"]/g,
  ]
  const identifiers = new Map() // id -> Set(files where deleted)
  for (const { file, text } of deleted) {
    for (const re of idRe) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
        const id = m[1] ?? m[0]
        if (id.length < 4) continue
        if (!identifiers.has(id)) identifiers.set(id, new Set())
        identifiers.get(id).add(file)
      }
    }
  }
  // A deleted identifier is only an orphan SIGNAL if it is specific: generic
  // words (`title`, `link`, `heading`) match hundreds of files and say nothing.
  // Keep identifiers that look like real hooks (data-*, hyphen/underscore/dot
  // in the name, or long) and that survive in a bounded number of files.
  const isSpecific = (id) => /^data-/.test(id) || /[-_.]/.test(id) || id.length >= 10
  const MAX_HITS = 25
  facts.orphanCandidates = []
  for (const [id, files] of identifiers) {
    if (!isSpecific(id)) continue
    const hits = git(repoDir, 'grep', '-l', '-F', '--', id, 'HEAD')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.replace(/^HEAD:/, ''))
      // the file that deleted it may still contain other uses — that is fine, not an orphan
      .filter((h) => !files.has(h))
    if (hits.length && hits.length <= MAX_HITS) {
      facts.orphanCandidates.push({ id, deletedIn: [...files], stillReferencedIn: hits.slice(0, 8), count: hits.length })
    }
  }
  facts.orphanCandidates.sort((a, b) => a.count - b.count)

  // ── 4. App hooks removed ───────────────────────────────────────────────────
  facts.appHooksDeleted = deleted
    .filter(({ text }) => APP_HOOK_RE.test(text))
    .slice(0, 20)
    .map(({ file, text }) => ({ file, text: text.trim().slice(0, 140) }))

  // ── 5. Reference integrity on HEAD (changed files only) ─────────────────────
  const changedPaths = status.filter((f) => f.status !== 'D').map((f) => f.path)
  const headText = (p) => fileAt(repoDir, 'HEAD', p) ?? ''
  const defaultLocalePath = git(repoDir, 'ls-files', '--', 'locales/*.default.json').trim().split('\n')[0]
  let defaultLocale = {}
  if (defaultLocalePath) {
    try {
      defaultLocale = flatten(JSON.parse(stripJsonBanner(headText(defaultLocalePath))))
      // A key referenced as 'a.b' is valid when the JSON holds a.b.one/other
      // (pluralization) or any nested object — register every ancestor prefix.
      for (const k of Object.keys(defaultLocale)) {
        const parts = k.split('.')
        for (let i = 1; i < parts.length; i++) defaultLocale[parts.slice(0, i).join('.')] ??= true
      }
    } catch { /* invalid JSON reported below */ }
  }
  facts.missingDefaultLocaleKeys = []
  facts.missingRenderTargets = []
  facts.settingsNotInSchema = []
  facts.customElements = { definedNotMounted: [], mountedNotDefined: [] }

  const allLiquid = git(repoDir, 'ls-files', '--', '*.liquid').split('\n').filter(Boolean)
  const allJs = git(repoDir, 'ls-files', '--', '*.js', '*.js.liquid').split('\n').filter(Boolean)
  const definedTags = new Set()
  for (const p of allJs) for (const m of headText(p).matchAll(/customElements\.define\(\s*['"]([\w-]+)['"]/g)) definedTags.add(m[1])

  for (const p of changedPaths) {
    const src = headText(p)
    if (p.endsWith('.liquid')) {
      for (const m of src.matchAll(/['"]([\w]+(?:\.[\w]+){1,4})['"]\s*\|\s*t\b/g)) {
        if (defaultLocalePath && !(m[1] in defaultLocale)) facts.missingDefaultLocaleKeys.push({ key: m[1], file: p })
      }
      for (const m of src.matchAll(/render\s+['"]([\w-]+)['"]/g)) {
        const root = p.includes('/snippets/') ? p.slice(0, p.indexOf('/snippets/')) + '/' : ''
        if (!existsSync(path.join(repoDir, `${root}snippets/${m[1]}.liquid`))) facts.missingRenderTargets.push({ snippet: m[1], file: p })
      }
      const schema = src.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema/)
      if (schema) {
        let ids = new Set()
        try {
          const j = JSON.parse(schema[1])
          for (const s of j.settings ?? []) if (s.id) ids.add(s.id)
          for (const b of j.blocks ?? []) for (const s of b.settings ?? []) if (s.id) ids.add(`block:${s.id}`)
        } catch { ids = null }
        if (ids) {
          for (const m of src.matchAll(/section\.settings\.([\w]+)/g)) if (!ids.has(m[1])) facts.settingsNotInSchema.push({ setting: `section.settings.${m[1]}`, file: p })
          for (const m of src.matchAll(/block\.settings\.([\w]+)/g)) if (!ids.has(`block:${m[1]}`)) facts.settingsNotInSchema.push({ setting: `block.settings.${m[1]}`, file: p })
        }
      }
      for (const m of src.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]+)[\s>]/g)) {
        const tag = m[1]
        if (/^(hover|hv|product|cart|slider|variant|quantity|modal|drawer|menu|header|predictive|localization|share|deferred|media|details|pickup|bulk|quick|price|recipient|show|sticky|pinned|multistep|lp|custom)-/.test(tag) && !definedTags.has(tag)) {
          facts.customElements.mountedNotDefined.push({ tag, file: p })
        }
      }
    }
    if (/\.js(\.liquid)?$/.test(p)) {
      for (const m of src.matchAll(/customElements\.define\(\s*['"]([\w-]+)['"]/g)) {
        const mounted = allLiquid.some((lp) => new RegExp(`<${m[1]}[\\s>]`).test(headText(lp)))
        if (!mounted) facts.customElements.definedNotMounted.push({ tag: m[1], file: p })
      }
    }
  }
  // dedupe
  const uniq = (arr, key) => [...new Map(arr.map((x) => [key(x), x])).values()]
  facts.missingDefaultLocaleKeys = uniq(facts.missingDefaultLocaleKeys, (x) => x.key)
  facts.settingsNotInSchema = uniq(facts.settingsNotInSchema, (x) => x.setting + x.file)
  facts.customElements.mountedNotDefined = uniq(facts.customElements.mountedNotDefined, (x) => x.tag)

  // ── 6. Hygiene on added lines ──────────────────────────────────────────────
  const added = []
  cur = null
  for (const line of diffU0.split('\n')) {
    if (line.startsWith('+++ b/')) cur = line.slice(6)
    else if (line.startsWith('+') && !line.startsWith('+++') && cur) added.push({ file: cur, text: line.slice(1) })
  }
  const grepAdded = (re) => added.filter(({ text }) => re.test(text)).slice(0, 15).map(({ file, text }) => ({ file, text: text.trim().slice(0, 120) }))
  facts.hygiene = {
    debugLeftovers: grepAdded(/console\.(log|debug|table)|debugger\b|\bTODO\b|\bFIXME\b/),
    importantAdded: added.filter(({ text }) => /!important/.test(text)).length,
    hardcodedStoreData: grepAdded(/all_products\[['"]|https?:\/\/[\w.-]+\.myshopify\.com|https?:\/\/(?:www\.)?[\w-]+\.(?:com|fr)\/(?:products|collections)\/|\d+,\d{2}\s?€|€\s?\d+/),
    secrets: grepAdded(SECRET_RE),
    silentFetch: (() => {
      const out = []
      for (const p of changedPaths.filter((x) => /\.js(\.liquid)?$/.test(x))) {
        const src = headText(p)
        for (const m of src.matchAll(/fetch\(([^)]{0,120})\)/g)) {
          const after = src.slice(m.index, m.index + 600)
          if (!/\.ok\b|response\.status|res\.status|catch\(|throw\b/.test(after)) out.push({ file: p, call: m[0].slice(0, 80) })
        }
      }
      return out.slice(0, 10)
    })(),
    allProductsInLoop: (() => {
      const out = []
      for (const p of changedPaths.filter((x) => x.endsWith('.liquid'))) {
        const src = headText(p)
        let depth = 0
        for (const [i, line] of src.split('\n').entries()) {
          if (/\{%-?\s*for\b/.test(line)) depth++
          if (/\{%-?\s*endfor/.test(line)) depth = Math.max(0, depth - 1)
          if (depth > 0 && /all_products\[/.test(line)) out.push({ file: p, line: i + 1 })
        }
      }
      return out.slice(0, 10)
    })(),
  }

  // ── 7. Merge hygiene: main moved on files this PR rewrites ─────────────────
  facts.mergeHygiene = []
  const prDeletedByFile = new Map()
  for (const { file } of deleted) prDeletedByFile.set(file, (prDeletedByFile.get(file) ?? 0) + 1)
  for (const [file, delCount] of prDeletedByFile) {
    if (delCount < 40) continue
    const mainLog = git(repoDir, 'log', '--format=%h %cs %s', '-3', baseRef, '--', file).trim()
    const inFeature = false
    facts.mergeHygiene.push({ file, deletedLines: delCount, mainRecentCommits: mainLog.split('\n').filter(Boolean).slice(0, 3) })
  }
  facts.mainFilesAlsoTouched = git(repoDir, 'diff', '--name-only', base, baseRef)
    .split('\n')
    .filter(Boolean)
    .filter((p) => status.some((f) => f.path === p))

  return facts
}

export function formatReviewFacts(f) {
  const out = []
  const list = (title, items, fmt) => {
    if (!items || !items.length) return
    out.push(`**${title}**`)
    for (const it of items) out.push(`- ${fmt(it)}`)
    out.push('')
  }
  out.push(`**Base de comparaison :** merge-base \`${f.base.slice(0, 7)}\` avec \`${f.baseRef}\` · \`${f.baseRef}\` a ${f.mainAheadBy} commit(s) d'avance sur la branche${f.mainAheadBy > 0 ? ' (branche en retard — risque de conflit)' : ''}.`)
  if (f.themeLiquidTouched) out.push(`**⚠️ \`layout/theme.liquid\` est modifié** — impact global, à justifier par la feature.`)
  out.push('')
  list('🚨 JSON INVALIDE (build ou éditeur cassé)', f.invalidJson, (j) => `\`${j.path}\` — ${j.error}`)
  const byStatus = { A: 'ajoutés', M: 'modifiés', D: 'supprimés', R: 'renommés' }
  out.push('**Fichiers :** ' + Object.entries(byStatus).map(([s, l]) => `${f.files.filter((x) => x.status === s).length} ${l}`).join(', '))
  out.push('')
  list('Changements de réglages (JSON, au niveau des clés — classer chacun : lié à la feature / édition live sans rapport)', f.jsonDiffs, (d) =>
    d.invalid ? `\`${d.path}\` — **JSON INVALIDE**` : `\`${d.path}\` (${d.total} changement(s))\n${d.changes.map((c) => `    ${c}`).join('\n')}`
  )
  list(`Identifiants supprimés par la PR mais encore référencés ailleurs sur la branche (candidats orphelins — à évaluer : consommateur cassé, ou référence légitime ?) — ${f.deletedLineCount} lignes supprimées au total`, f.orphanCandidates.slice(0, 25), (o) =>
    `\`${o.id}\` supprimé dans ${o.deletedIn.join(', ')} — encore dans ${o.count} fichier(s) : ${o.stillReferencedIn.join(', ')}`
  )
  list('Lignes supprimées qui mentionnent une app tierce (vérifier que rien de consommé par l\'app ne disparaît)', f.appHooksDeleted, (h) => `\`${h.file}\` : \`${h.text}\``)
  list('Clés de traduction utilisées mais ABSENTES de la locale par défaut', f.missingDefaultLocaleKeys, (k) => `\`${k.key}\` dans \`${k.file}\``)
  list('`{% render %}` vers un snippet qui n\'existe pas sur la branche', f.missingRenderTargets, (r) => `\`${r.snippet}\` depuis \`${r.file}\``)
  list('Réglages lus dans le Liquid mais absents du schema du fichier', f.settingsNotInSchema, (s) => `\`${s.setting}\` dans \`${s.file}\``)
  list('Custom elements définis mais montés nulle part', f.customElements.definedNotMounted, (c) => `\`<${c.tag}>\` défini dans \`${c.file}\``)
  list('Balises custom montées mais jamais définies en JS', f.customElements.mountedNotDefined, (c) => `\`<${c.tag}>\` dans \`${c.file}\``)
  list('Réécritures massives — fichiers où la PR supprime ≥40 lignes (vérifier : refonte voulue, ou résolution de merge qui écrase des changements récents de main ?)', f.mergeHygiene, (m) =>
    `\`${m.file}\` — ${m.deletedLines} lignes supprimées · derniers commits de main sur ce fichier : ${m.mainRecentCommits.join(' · ') || '(aucun)'}`
  )
  list('Fichiers que main a AUSSI modifiés depuis la divergence (zone de conflit)', f.mainFilesAlsoTouched.slice(0, 20), (p) => `\`${p}\``)
  const h = f.hygiene
  list('Debug / TODO ajoutés', h.debugLeftovers, (d) => `\`${d.file}\` : \`${d.text}\``)
  if (h.importantAdded) out.push(`**\`!important\` ajoutés :** ${h.importantAdded}\n`)
  list('Données boutique en dur ajoutées (handles, URLs absolues, prix formatés)', h.hardcodedStoreData, (d) => `\`${d.file}\` : \`${d.text}\``)
  list('🚨 Secrets potentiels', h.secrets, (d) => `\`${d.file}\` : \`${d.text}\``)
  list('`fetch()` sans traitement visible de l\'échec (ni `.ok`, ni catch, ni throw à proximité) — vérifier ce que voit l\'utilisateur quand ça échoue', h.silentFetch, (d) => `\`${d.file}\` : \`${d.call}\``)
  list('`all_products[...]` dans une boucle (plafond Shopify ~20/page)', h.allProductsInLoop, (d) => `\`${d.file}:${d.line}\``)
  return out.join('\n')
}

// CLI: node scripts/lib/review-facts.js <repoDir> [baseRef]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [dir, baseRef] = process.argv.slice(2)
  if (!dir) {
    console.error('usage: review-facts.js <repoDir> [baseRef=origin/main]')
    process.exit(2)
  }
  console.log(formatReviewFacts(buildReviewFacts(dir, baseRef ?? 'origin/main')))
}
