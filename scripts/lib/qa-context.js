import { parse as parseYaml } from 'yaml'
import { fetchFileContent, fetchDirectoryListing } from './github.js'

const DIFF_LIMIT = 60_000
const SINGLE_FILE_LIMIT = 8_000
const TOTAL_RELATED_LIMIT = 30_000

const RENDER_TAG_RE = /\{%-?\s*render\s+['"]([^'"]+)['"]/g

function isLiquidComponent(filename) {
  return (
    filename.endsWith('.liquid') &&
    (filename.startsWith('sections/') ||
      filename.startsWith('snippets/') ||
      filename.startsWith('components/') ||
      filename.includes('/sections/') ||
      filename.includes('/snippets/') ||
      filename.includes('/components/'))
  )
}

function isJs(filename) {
  return filename.endsWith('.js') || filename.endsWith('.js.liquid')
}

function shouldSkip(filename) {
  if (filename.endsWith('.css') || filename.endsWith('.scss')) return true
  if (filename.endsWith('.json')) return true
  if (filename.includes('config/')) return true
  return false
}

function parseRenderedSnippets(content) {
  const names = new Set()
  for (const match of content.matchAll(RENDER_TAG_RE)) {
    names.add(match[1])
  }
  return [...names]
}

function snippetPathFor(filename, snippetName) {
  const snippetsRoot = filename.includes('/snippets/')
    ? filename.slice(0, filename.indexOf('/snippets/')) + '/snippets'
    : 'snippets'
  return `${snippetsRoot}/${snippetName}.liquid`
}

function templatesRootFor(filename) {
  const marker = ['/sections/', '/snippets/', '/components/'].find((m) => filename.includes(m))
  return marker ? filename.slice(0, filename.indexOf(marker)) + '/templates' : 'templates'
}

const SCHEMA_BLOCK_RE = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/

function parseSchemaSettings(filePath, content) {
  const match = content.match(SCHEMA_BLOCK_RE)
  if (!match) return null
  let schema
  try {
    schema = JSON.parse(match[1])
  } catch {
    return null
  }
  const settings = (schema.settings || [])
    .filter((s) => s.id && s.label)
    .map((s) => {
      const parts = [`- \`${s.id}\` — "${s.label}" (${s.type})`]
      if (Array.isArray(s.options) && s.options.length) {
        const opts = s.options.map((o) => `"${o.label ?? o.value}"`).join(', ')
        parts.push(`options: ${opts}`)
      }
      if (s.type === 'range') {
        parts.push(`range: ${s.min ?? '?'}–${s.max ?? '?'} step ${s.step ?? '?'}`)
      }
      if (s.type === 'checkbox') {
        parts.push(`default: ${s.default}`)
      }
      return parts.join(' — ')
    })
  const blockSettings = (schema.blocks || []).map((b) => {
    const blockSettingsList = (b.settings || [])
      .filter((s) => s.id && s.label)
      .map((s) => `  - \`${s.id}\` — "${s.label}" (${s.type})`)
      .join('\n')
    return `Block type \`${b.type}\` ("${b.name}"):\n${blockSettingsList || '  (no settings)'}`
  })
  if (!settings.length && !blockSettings.length) return null
  return [`### ${filePath} — section settings`, ...settings, ...blockSettings].join('\n')
}

const METAFIELD_RE = /\bmetafields?\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/g

function parseMetafieldReferences(content) {
  const refs = new Set()
  for (const m of content.matchAll(METAFIELD_RE)) {
    refs.add(`metafields.${m[1]}.${m[2]}`)
  }
  for (const line of content.split('\n')) {
    if (/metaobject/i.test(line)) {
      refs.add(line.trim().slice(0, 160))
    }
  }
  return [...refs]
}

function collectSectionHandles(changedFiles) {
  return changedFiles
    .filter(
      (f) =>
        f.filename.endsWith('.liquid') &&
        (f.filename.includes('/sections/') || f.filename.startsWith('sections/'))
    )
    .map((f) => {
      const base = f.filename.split('/').pop()
      return { filename: f.filename, handle: base.replace(/\.liquid$/, '') }
    })
}

function viewSuffixForTemplate(templatePath, baseType) {
  const base = templatePath.split('/').pop().replace(/\.json$/, '')
  if (base === baseType) return null
  return base.slice(baseType.length + 1) || null
}

async function fetchTemplatesReferencingSections(repo, sectionHandles, headRef) {
  if (!sectionHandles.length) return []
  const templatesRoot = templatesRootFor(sectionHandles[0].filename)

  let templatePaths
  try {
    templatePaths = await fetchDirectoryListing(repo, templatesRoot, headRef)
  } catch {
    return []
  }
  templatePaths = templatePaths.filter((p) => p.endsWith('.json'))

  const results = []
  for (const templatePath of templatePaths) {
    let content
    try {
      content = await fetchFileContent(repo, templatePath, headRef)
    } catch {
      continue
    }
    for (const { handle } of sectionHandles) {
      if (content.includes(`"type": "${handle}"`) || content.includes(`"type":"${handle}"`)) {
        const fileBase = templatePath.split('/').pop().replace(/\.json$/, '')
        const baseType = fileBase.split('.')[0]
        const suffix = viewSuffixForTemplate(templatePath, baseType)
        results.push({ handle, templatePath, viewSuffix: suffix })
      }
    }
  }
  return results
}

async function fetchQaSpecs(repo, headRef) {
  let content
  try {
    content = await fetchFileContent(repo, 'project-specs.md', headRef)
  } catch {
    return null
  }
  // Candidate YAML regions, in priority order:
  // 1. any ```yaml fenced block (the documented canonical form)
  // 2. the unfenced tail starting at a top-level `qa:` line — the form the CROs
  //    actually commit (flat: `qa:` then `products:`/`pages:` at column 0, block
  //    running to EOF or until the next markdown heading/table/fence)
  const candidates = []
  for (const match of content.matchAll(/```ya?ml\n([\s\S]*?)```/g)) candidates.push(match[1])
  const bareIdx = content.search(/^qa:/m)
  if (bareIdx !== -1) {
    const lines = content.slice(bareIdx).split('\n')
    const end = lines.findIndex((l, i) => i > 0 && /^(#{1,6}\s|\||```)/.test(l))
    candidates.push((end === -1 ? lines : lines.slice(0, end)).join('\n'))
  }

  for (const raw of candidates) {
    if (!/^qa:/m.test(raw)) continue
    let parsed
    try {
      parsed = parseYaml(raw)
    } catch {
      continue
    }
    // Accept both nested (`qa:` holds products/pages) and flat (`qa:` is empty,
    // products/pages sit at the top level) layouts.
    const src = parsed && typeof parsed.qa === 'object' && parsed.qa ? parsed.qa : parsed
    if (!src || (!Array.isArray(src.products) && typeof src.pages !== 'object')) continue
    const products = Array.isArray(src.products)
      ? src.products
          .filter((p) => p && p.handle)
          .map((p) => ({
            handle: String(p.handle).trim(),
            template: p.template ? String(p.template).trim() : 'default',
          }))
      : []
    const pages =
      src.pages && typeof src.pages === 'object'
        ? Object.fromEntries(Object.entries(src.pages).map(([k, v]) => [k, String(v).trim()]))
        : {}
    if (!products.length && !Object.keys(pages).length) continue
    return { products, pages }
  }
  return null
}

function formatQaSpecs(specs) {
  if (!specs || !specs.products.length) return null
  const productLines = specs.products.map((p) => {
    const tpl =
      !p.template || p.template === 'default'
        ? 'template produit par défaut (`templates/product.json`)'
        : `template \`${p.template}\` (charger via \`?view=${p.template}\`)`
    return `- \`/products/${p.handle}\` — ${tpl}`
  })
  const pageLines = Object.entries(specs.pages).map(([name, path]) => `- ${name}: ${path}`)
  return [
    'Test products — the ONLY valid product handles. Every `/products/...` URL MUST use one of these exact handles (the linter rejects any other). Each product is bound to a stable Shopify template (a product is assigned to one template and it does not change; what that template contains is NOT declared here — it is read from the branch code at run time):',
    ...productLines,
    '',
    'Rule: a changed section only renders on products whose template includes it. To test a changed section, pick a test product whose template matches one of the templates listed under "Templates that reference changed sections" below — that is the only way to know the section will actually render. NEVER test a section on a product whose template does not contain it (it renders empty and produces false failures). If no test product uses a template that contains the changed section, move that check to `regression` instead of inventing a handle.',
    ...(pageLines.length ? ['', 'Key pages (use these exact paths):', ...pageLines] : []),
  ].join('\n')
}

async function gatherRelatedFiles(repo, changedFiles, headRef) {
  const related = new Map()
  const seenSnippetPaths = new Set()

  for (const file of changedFiles) {
    if (shouldSkip(file.filename)) continue

    if (isLiquidComponent(file.filename)) {
      let content
      try {
        content = await fetchFileContent(repo, file.filename, headRef)
      } catch {
        continue
      }
      related.set(file.filename, content)

      const renderedNames = parseRenderedSnippets(content)
      for (const name of renderedNames) {
        const snippetPath = snippetPathFor(file.filename, name)
        if (seenSnippetPaths.has(snippetPath) || related.has(snippetPath)) continue
        seenSnippetPaths.add(snippetPath)
        try {
          const snippetContent = await fetchFileContent(repo, snippetPath, headRef)
          related.set(snippetPath, snippetContent)
        } catch {
          // referenced snippet not found at this path — skip
        }
      }
    } else if (isJs(file.filename)) {
      try {
        const content = await fetchFileContent(repo, file.filename, headRef)
        related.set(file.filename, content)
      } catch {
        // skip unreadable file
      }
    }
  }

  return related
}

function capRelatedFiles(related) {
  const entries = [...related.entries()].map(([filePath, content]) => ({
    filePath,
    content: content.length > SINGLE_FILE_LIMIT ? content.slice(0, SINGLE_FILE_LIMIT) : content,
  }))

  entries.sort((a, b) => b.content.length - a.content.length)

  let total = entries.reduce((sum, e) => sum + e.content.length, 0)
  while (total > TOTAL_RELATED_LIMIT && entries.length > 0) {
    const largest = entries.shift()
    total -= largest.content.length
  }

  return entries
}

function buildRelatedFilesContext(entries) {
  return entries.map((e) => `--- ${e.filePath} ---\n${e.content}`).join('\n\n')
}

export async function buildQaUserPrompt({ repo, prNumber, headRef, pr, diff, changedFiles }) {
  const qaSpecs = await fetchQaSpecs(repo, headRef)
  const qaContext = formatQaSpecs(qaSpecs)
  const allowedHandles = qaSpecs ? qaSpecs.products.map((p) => p.handle) : []
  const related = await gatherRelatedFiles(repo, changedFiles, headRef)
  const cappedEntries = capRelatedFiles(related)
  const relatedFilesContext = buildRelatedFilesContext(cappedEntries)

  const schemaSettingsContext = cappedEntries
    .map((e) => parseSchemaSettings(e.filePath, e.content))
    .filter(Boolean)
    .join('\n\n')

  const metafieldRefs = new Set()
  for (const e of cappedEntries) {
    for (const ref of parseMetafieldReferences(e.content)) metafieldRefs.add(ref)
  }
  for (const ref of parseMetafieldReferences(diff)) metafieldRefs.add(ref)

  const sectionHandles = collectSectionHandles(changedFiles)
  const templateMatches = await fetchTemplatesReferencingSections(repo, sectionHandles, headRef)
  const templatesContext = templateMatches
    .map((m) =>
      m.viewSuffix
        ? `- Section \`${m.handle}\` appears in \`${m.templatePath}\` — preview via \`?view=${m.viewSuffix}\` on a matching page`
        : `- Section \`${m.handle}\` appears in \`${m.templatePath}\` (default template)`
    )
    .join('\n')

  const truncatedDiff =
    diff.length > DIFF_LIMIT
      ? `${diff.slice(0, DIFF_LIMIT)}\n\n[diff truncated at ${DIFF_LIMIT} chars]`
      : diff

  const fileList = changedFiles
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join('\n')

  const timestamp = new Date().toISOString()

  const userPrompt = [
    `PR title: ${pr.title}`,
    `PR number: ${prNumber}`,
    `Head ref: ${headRef}`,
    `Timestamp: ${timestamp}`,
    '',
    'PR body:',
    pr.body || '(empty)',
    '',
    'Test products and key pages from the `qa` block of project-specs.md (the ONLY allowed source for product handles and URLs — never invent a handle, never write a placeholder):',
    qaContext ||
      '(missing — do not write any step that requires a specific product; describe those checks in `regression` instead)',
    '',
    'Changed files:',
    fileList,
    '',
    'Diff:',
    '```diff',
    truncatedDiff,
    '```',
    '',
    'Related file context:',
    relatedFilesContext || '(none)',
    '',
    'Section/block schema settings (extracted — enumerate every one of these):',
    schemaSettingsContext || '(none found)',
    '',
    'Metafield/metaobject references detected in code (instruct tester how to verify empty/missing state for each):',
    metafieldRefs.size ? [...metafieldRefs].map((r) => `- ${r}`).join('\n') : '(none found)',
    '',
    'Templates that reference changed sections (state every one explicitly, with the ?view= trick where applicable):',
    templatesContext || '(none found — section may be new/unreferenced, or check manually)',
  ].join('\n')

  return { userPrompt, timestamp, allowedHandles }
}
