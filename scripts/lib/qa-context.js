import { parse as parseYaml } from 'yaml'
import { fetchFileContent, fetchDirectoryListing } from './github.js'
import { extractFacts, formatFacts, factInventory } from './extract-facts.js'

// NO truncation, NO budgets. Policy (2026-08-31): every file the PR changed
// goes in FULL, and every transitively-needed file (rendered snippets, companion
// JS/CSS) goes in FULL. A half-read file misleads more than it saves: the model
// reports handlers whose bodies it never saw and invents the outcome. The only
// exclusions are compiled bundles (see isCompiledBundle) — their source is
// fetched separately. If a prompt outgrows the model's context window we fail
// loudly at build time (see the size warning in buildQaUserPrompt) instead of
// silently feeding the model an amputated theme.

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

function isStylesheet(filename) {
  return filename.endsWith('.css') || filename.endsWith('.scss') || filename.endsWith('.css.liquid')
}

// Changed files are NEVER skipped — if the PR touched it, the model sees it in
// full, locales and template JSON included (a changed template JSON is often the
// only proof of which settings the feature ships with). The single exception is
// compiled bundles, whose source is fetched separately.


// Themes commit their build output (`_hover-bundle.js.liquid`, `theme.min.css`).
// These are enormous, unreadable, and a duplicate of source we already fetch, so
// they used to consume the whole related-files budget and evict the real source.
// Detect by shape rather than by name: minifiers strip newlines, so the giveaway
// is a very high average line length.
function isCompiledBundle(filePath, content) {
  if (/\.min\.(js|css)(\.liquid)?$/.test(filePath)) return true
  // Hover themes concatenate every component into `_hover-bundle.js.liquid` /
  // `_hover-bundle.css.liquid`. It is NOT minified, so the line-length test below
  // misses it, and because it contains the whole theme it reports custom elements
  // and events from components this PR never touched — inventing an agenda of
  // unmounted, unrelated tags. The per-component source is fetched separately.
  if (/(?:^|\/)_?[\w-]*bundle\.(js|css)(\.liquid)?$/.test(filePath)) return true
  if (content.length < 20_000) return false
  const lines = content.split('\n').length
  return content.length / lines > 400
}

// A component's behaviour usually lives in a sibling asset that the diff may not
// touch: `sections/foo.liquid` pairs with `assets/foo.js`, `js/snippets/_foo.js`,
// `css/snippets/_foo.scss`. Following {% render %} alone never reaches these, so
// the model saw the markup and none of the logic that drives it.
function companionAssetPaths(filename) {
  const root = themeRootFor(filename)
  const base = filename.split('/').pop().replace(/\.liquid$/, '')
  const bare = base.replace(/^_/, '')
  const names = [...new Set([base, bare, `_${bare}`])]
  const paths = []
  for (const name of names) {
    paths.push(
      `${root}assets/${name}.js`,
      `${root}assets/${name}.css`,
      `${root}js/snippets/${name}.js`,
      `${root}js/sections/${name}.js`,
      `${root}css/snippets/${name}.scss`,
      `${root}css/sections/${name}.scss`
    )
  }
  return [...new Set(paths)]
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

function themeRootFor(filename) {
  const marker = ['/sections/', '/snippets/', '/components/'].find((m) => filename.includes(m))
  return marker ? filename.slice(0, filename.indexOf(marker)) + '/' : ''
}

function templatesRootFor(filename) {
  return `${themeRootFor(filename)}templates`
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

// Global sections (header, footer, cart-drawer, announcement bar…) are bound to
// no template: they live in a section group (`sections/*-group.json`, rendered by
// `{% sections '<group>' %}`) or are called directly from a layout
// (`{% section '<handle>' %}` in `layout/theme.liquid`). Template scanning finds
// nothing for them, so the model used to get "(none found)" and had no URL to
// test on. These resolve to "renders on every page using that layout" instead.
const LAYOUT_SECTION_RE = /\{%-?\s*section\s+['"]([^'"]+)['"]/g
const LAYOUT_SECTION_GROUP_RE = /\{%-?\s*sections\s+['"]([^'"]+)['"]/g

function sectionGroupName(groupPath) {
  // header-group.json and header-group.context.fr.json are the same group
  return groupPath.split('/').pop().replace(/\.json$/, '').split('.')[0]
}

// Section groups are JSON prefixed with Shopify's auto-generated /* */ banner.
// Read the section types from `sections` only: a `"type"` string search would
// also hit block types (`text`, `image_with_text`, `header`…) and flag a section
// as global because a block happens to share its name.
function sectionTypesInGroup(content) {
  let json
  try {
    json = JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\//, ''))
  } catch {
    return null
  }
  if (!json || typeof json.sections !== 'object' || !json.sections) return null
  return new Set(
    Object.values(json.sections)
      .map((s) => s && s.type)
      .filter(Boolean)
  )
}

async function fetchGlobalSectionUsages(repo, sectionHandles, headRef) {
  if (!sectionHandles.length) return []
  const root = themeRootFor(sectionHandles[0].filename)
  const handles = sectionHandles.map((s) => s.handle)

  // Which section groups contain a changed section
  let groupPaths = []
  try {
    groupPaths = (await fetchDirectoryListing(repo, `${root}sections`, headRef)).filter((p) =>
      p.endsWith('.json')
    )
  } catch {
    // no sections directory at this root
  }
  const groupsWithHandle = new Map() // group name -> Set of handles
  for (const groupPath of groupPaths) {
    let content
    try {
      content = await fetchFileContent(repo, groupPath, headRef)
    } catch {
      continue
    }
    const types = sectionTypesInGroup(content)
    for (const handle of handles) {
      const used = types
        ? types.has(handle)
        : content.includes(`"type": "${handle}"`) || content.includes(`"type":"${handle}"`)
      if (!used) continue
      const group = sectionGroupName(groupPath)
      if (!groupsWithHandle.has(group)) groupsWithHandle.set(group, new Set())
      groupsWithHandle.get(group).add(handle)
    }
  }

  // Which layouts call a changed section directly, and which render those groups
  let layoutPaths = []
  try {
    layoutPaths = (await fetchDirectoryListing(repo, `${root}layout`, headRef)).filter((p) =>
      p.endsWith('.liquid')
    )
  } catch {
    // no layout directory at this root
  }
  const usages = []
  const seen = new Set()
  const push = (usage) => {
    const key = `${usage.handle}|${usage.layout}|${usage.group ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    usages.push(usage)
  }

  for (const layoutPath of layoutPaths) {
    let content
    try {
      content = await fetchFileContent(repo, layoutPath, headRef)
    } catch {
      continue
    }
    const layout = layoutPath.split('/').pop()
    const direct = new Set([...content.matchAll(LAYOUT_SECTION_RE)].map((m) => m[1]))
    const rendered = new Set([...content.matchAll(LAYOUT_SECTION_GROUP_RE)].map((m) => m[1]))
    for (const handle of handles) {
      if (direct.has(handle)) push({ handle, layout, group: null })
    }
    for (const [group, groupHandles] of groupsWithHandle) {
      if (!rendered.has(group)) continue
      for (const handle of groupHandles) push({ handle, layout, group })
    }
  }

  // A group nothing renders (or a repo whose layouts we could not read) still
  // beats reporting nothing: flag it as global-but-unconfirmed.
  for (const [group, groupHandles] of groupsWithHandle) {
    for (const handle of groupHandles) {
      if (usages.some((u) => u.handle === handle && u.group === group)) continue
      push({ handle, layout: null, group })
    }
  }

  return usages
}

function formatGlobalUsages(usages) {
  if (!usages.length) return null
  // One line per (section, origin): a theme ships several layouts (gempages,
  // app-specific variants) and repeating the same section once per layout buries
  // the only fact that matters — whether it is on the default layout or not.
  const byOrigin = new Map()
  for (const u of usages) {
    const key = `${u.handle}|${u.group ?? ''}`
    if (!byOrigin.has(key)) byOrigin.set(key, { handle: u.handle, group: u.group, layouts: [] })
    if (u.layout) byOrigin.get(key).layouts.push(u.layout)
  }

  const lines = [...byOrigin.values()].map(({ handle, group, layouts }) => {
    const origin = group
      ? `part of the \`${group}\` section group`
      : 'called directly from a layout'
    if (!layouts.length) {
      return `- Section \`${handle}\` is a GLOBAL section — ${origin}, but no layout was found rendering it (verify manually which pages show it).`
    }
    if (layouts.includes('theme.liquid')) {
      return `- Section \`${handle}\` is a GLOBAL section — ${origin}, rendered by \`layout/theme.liquid\`, so it renders on EVERY storefront page.`
    }
    const list = layouts.map((l) => `\`layout/${l}\``).join(', ')
    return `- Section \`${handle}\` is a GLOBAL section — ${origin}, but rendered only by ${list} and NOT by the default \`layout/theme.liquid\` — check manually which pages use that layout before testing it.`
  })

  return [
    ...lines,
    '',
    'A global section is bound to NO template: never look for a `?view=` suffix for it, never bind it to a product template, and never move it to `regression` for lack of a template. Navigate to a key page from the `qa` block (the home page `/` by default, or any listed page) and assert the section there. Leave `templates` empty (`templates: []`) when every changed section is global.',
  ].join('\n')
}

async function fetchQaSpecs(repo, headRef, baseRef) {
  // project-specs.md is a repo-level contract maintained on the default branch.
  // Read the head ref first (a PR may edit the specs), then fall back to base:
  // most feature branches predate the specs commit and 404 on head.
  const refs = baseRef && baseRef !== headRef ? [headRef, baseRef] : [headRef]
  for (const ref of refs) {
    let content
    try {
      content = await fetchFileContent(repo, 'project-specs.md', ref)
    } catch {
      continue
    }
    const parsed = parseQaSpecs(content)
    if (parsed) return parsed
  }
  return null
}

function parseQaSpecs(content) {
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
    'Rule: a changed section only renders on products whose template includes it. To test a changed section, pick a test product whose template matches one of the templates listed under "Templates that reference changed sections" below — that is the only way to know the section will actually render. NEVER test a section on a product whose template does not contain it (it renders empty and produces false failures). If no test product uses a template that contains the changed section, move that check to `regression` instead of inventing a handle. This whole rule is about template-bound sections only — a section listed under "Global sections" below has no template and is tested on a key page instead.',
    ...(pageLines.length
      ? ['', 'Key pages (use these exact paths):', ...pageLines]
      : [
          '',
          'Key pages: none declared in project-specs.md. The home page `/` is always a valid path on a Shopify storefront — use it (and only it) when a check needs a non-product page, e.g. a global section.',
        ]),
  ].join('\n')
}

// Eviction order is by tier, worst first. `behaviour` outranks `primary` markup
// on purpose: a 111k-char section file the PR touched is worth less to a test
// plan than the 3k-char JS that defines what its buttons actually do.
const TIER_BEHAVIOUR = 0 // JS anywhere in the component set — never evicted
const TIER_PRIMARY = 1 // markup/styles the PR changed
const TIER_SECONDARY = 2 // transitively reached snippets and companion styles

// Locale dictionaries are the one changed-file class we do not inline in full:
// a theme's en.default.json alone is ~65k tokens, the PR usually touches two
// keys, and those exact lines are already visible in the diff. Everything else
// the PR changed ships whole.
function isLocaleDictionary(filePath) {
  return /(^|\/)locales\/[^/]+\.json$/.test(filePath)
}

// Same argument, wider net: template/config/section-group JSON is machine data,
// often enormous (a Replo/GemPages landing template runs 200k+ chars), and every
// line the PR changed is already in the diff verbatim. Schema settings from
// Liquid files are extracted separately; nothing here carries behaviour.
function isDataJson(filePath) {
  return filePath.endsWith('.json')
}

async function addFile(repo, related, filePath, headRef, tier) {
  if (related.has(filePath)) {
    // Keep the strongest tier if a file is reached twice (changed AND rendered).
    const existing = related.get(filePath)
    if (tier < existing.tier) existing.tier = tier
    return null
  }
  let content
  try {
    content = await fetchFileContent(repo, filePath, headRef)
  } catch {
    return null
  }
  if (isCompiledBundle(filePath, content)) {
    related.set(filePath, { content: '', tier, skipped: 'compiled bundle — source is included instead' })
    return null
  }
  if (isLocaleDictionary(filePath)) {
    related.set(filePath, { content: '', tier, skipped: 'locale dictionary — the changed keys are in the diff' })
    return null
  }
  if (isDataJson(filePath)) {
    related.set(filePath, { content: '', tier, skipped: 'data JSON — the changed lines are in the diff' })
    return null
  }
  related.set(filePath, { content, tier })
  return content
}

async function gatherRelatedFiles(repo, changedFiles, headRef) {
  const related = new Map()

  for (const file of changedFiles) {
    if (file.status === 'removed') continue

    const tier = isJs(file.filename) ? TIER_BEHAVIOUR : TIER_PRIMARY
    const content = await addFile(repo, related, file.filename, headRef, tier)
    if (!content) continue

    if (isLiquidComponent(file.filename)) {
      // Snippet + companion fetches are mostly 404 probes — run them in
      // parallel per changed file (addFile dedupes via the shared map).
      await Promise.all([
        ...parseRenderedSnippets(content).map((name) =>
          addFile(repo, related, snippetPathFor(file.filename, name), headRef, TIER_SECONDARY)
        ),
        // Pull in the component's own JS/CSS even when the diff never touched it.
        ...companionAssetPaths(file.filename).map((assetPath) =>
          addFile(repo, related, assetPath, headRef, isJs(assetPath) ? TIER_BEHAVIOUR : TIER_SECONDARY)
        ),
      ])
    }
  }

  return related
}


function buildRelatedFilesContext(entries, related) {
  const files = entries.map((e) => `--- ${e.filePath} ---\n${e.content}`)
  // Name what was deliberately left out, so an absent file reads as a decision
  // rather than as evidence the component does not exist.
  const skipped = [...related.entries()]
    .filter(([, v]) => v.skipped)
    .map(([filePath, v]) => `--- ${filePath} --- [omitted: ${v.skipped}]`)
  return [...files, ...skipped].join('\n\n')
}

// The compiled bundle rule applies to the diff too: a `_hover-bundle.js.liquid`
// hunk is the build output of a source hunk sitting right next to it in the same
// diff. On rez-energy-v2#37 the bundle hunks alone were 73k chars (~18k tokens)
// of pure duplication.
function stripBundleHunksFromDiff(diff) {
  const parts = diff.split(/(?=diff --git )/)
  const kept = []
  const strippedPaths = []
  for (const part of parts) {
    const m = part.match(/^diff --git a\/(\S+)/)
    if (m && isCompiledBundle(m[1], '')) {
      strippedPaths.push(m[1])
      continue
    }
    kept.push(part)
  }
  if (!strippedPaths.length) return diff
  return (
    kept.join('') +
    `\n[diff hunks omitted for compiled bundles (source hunks are above): ${strippedPaths.join(', ')}]\n`
  )
}

export async function buildQaUserPrompt({ repo, prNumber, headRef, pr, diff, changedFiles }) {
  diff = stripBundleHunksFromDiff(diff)
  const qaSpecs = await fetchQaSpecs(repo, headRef, pr?.base?.ref)
  const qaContext = formatQaSpecs(qaSpecs)
  const allowedHandles = qaSpecs ? qaSpecs.products.map((p) => p.handle) : []
  const related = await gatherRelatedFiles(repo, changedFiles, headRef)
  const cappedEntries = [...related.entries()]
    .filter(([, v]) => !v.skipped)
    .map(([filePath, { content, tier }]) => ({ filePath, tier, content }))
  const relatedFilesContext = buildRelatedFilesContext(cappedEntries, related)

  const extracted = extractFacts(cappedEntries)
  const factsContext = formatFacts(extracted)

  console.error(
    `QA context: ${cappedEntries.length} files, ${relatedFilesContext.length} chars of code, diff ${diff.length} chars`
  )

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
  const [templateMatches, globalUsages] = await Promise.all([
    fetchTemplatesReferencingSections(repo, sectionHandles, headRef),
    fetchGlobalSectionUsages(repo, sectionHandles, headRef),
  ])
  const globalContext = formatGlobalUsages(globalUsages)
  const templatesContext = templateMatches
    .map((m) =>
      m.viewSuffix
        ? `- Section \`${m.handle}\` appears in \`${m.templatePath}\` — preview via \`?view=${m.viewSuffix}\` on a matching page`
        : `- Section \`${m.handle}\` appears in \`${m.templatePath}\` (default template)`
    )
    .join('\n')


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
    diff,
    '```',
    '',
    'Related file context:',
    relatedFilesContext || '(none)',
    '',
    'Static facts extracted from the code above (custom elements, events, cart calls, device branches, state toggles). This list is exhaustive and machine-generated — it is your agenda: every entry must be either covered by a test or explicitly declined with a reason:',
    factsContext || '(no behavioural code found in the changed component set)',
    '',
    'Section/block schema settings (extracted — enumerate every one of these):',
    schemaSettingsContext || '(none found)',
    '',
    'Metafield/metaobject references detected in code (instruct tester how to verify empty/missing state for each):',
    metafieldRefs.size ? [...metafieldRefs].map((r) => `- ${r}`).join('\n') : '(none found)',
    '',
    'Templates that reference changed sections (state every one explicitly, with the ?view= trick where applicable):',
    templatesContext || '(none found — the section may be global: see the next block)',
    '',
    'Global sections — changed sections bound to no template (layout or section group):',
    globalContext || '(none — every changed section is template-bound)',
  ].join('\n')

  // Fail loudly, not silently: past ~190k tokens the API rejects the request,
  // and a 413 with this line in the log beats a truncated theme any day.
  const approxTokens = Math.round(userPrompt.length / 4)
  if (approxTokens > 170_000) {
    console.error(
      `WARNING: QA prompt is ~${approxTokens} tokens — near or past the model's context window. If the API rejects it, split the PR or exclude vendored assets; do NOT reintroduce silent truncation.`
    )
  }

  // Views whose template actually contains a changed section — the linter uses
  // these to reject steps bound to a template where the code never renders.
  const sectionViews = [
    ...new Set(templateMatches.map((m) => m.viewSuffix).filter((v) => typeof v === 'string' && v)),
  ]

  return {
    userPrompt,
    timestamp,
    allowedHandles,
    sectionViews,
    hasSchemaSettings: Boolean(schemaSettingsContext),
    facts: factInventory(extracted),
  }
}
