import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  fetchPR,
  fetchDiff,
  fetchChangedFiles,
  fetchFileContent,
  fetchDirectoryListing,
  postComment,
  addLabel,
} from './lib/github.js'
import { ask } from './lib/claude.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
  return entries
    .map((e) => `--- ${e.filePath} ---\n${e.content}`)
    .join('\n\n')
}

async function main() {
  const { REPO, PR_NUMBER, HEAD_REF } = process.env
  if (!REPO || !PR_NUMBER || !HEAD_REF) {
    throw new Error('Missing required env vars: REPO, PR_NUMBER, HEAD_REF')
  }

  const [pr, diff, changedFiles] = await Promise.all([
    fetchPR(REPO, PR_NUMBER),
    fetchDiff(REPO, PR_NUMBER),
    fetchChangedFiles(REPO, PR_NUMBER),
  ])

  const related = await gatherRelatedFiles(REPO, changedFiles, HEAD_REF)
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
  const templateMatches = await fetchTemplatesReferencingSections(REPO, sectionHandles, HEAD_REF)
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

  const systemPrompt = await readFile(path.join(__dirname, '..', 'prompts', 'qa.md'), 'utf-8')

  const fileList = changedFiles
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join('\n')

  const timestamp = new Date().toISOString()

  const userPrompt = [
    `PR title: ${pr.title}`,
    `PR number: ${PR_NUMBER}`,
    `Head ref: ${HEAD_REF}`,
    `Timestamp: ${timestamp}`,
    '',
    'PR body:',
    pr.body || '(empty)',
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
    'Section/block schema settings (extracted — enumerate every one of these in the human checklist):',
    schemaSettingsContext || '(none found)',
    '',
    'Metafield/metaobject references detected in code (instruct tester how to verify empty/missing state for each):',
    metafieldRefs.size ? [...metafieldRefs].map((r) => `- ${r}`).join('\n') : '(none found)',
    '',
    'Templates that reference changed sections (state every one explicitly, with the ?view= trick where applicable):',
    templatesContext || '(none found — section may be new/unreferenced, or check manually)',
  ].join('\n')

  let qaComment
  try {
    qaComment = await ask(systemPrompt, userPrompt, 16000)
    if (!qaComment || !qaComment.trim()) {
      throw new Error('empty response')
    }
  } catch (err) {
    console.error('Claude QA generation failed:', err)
    await postComment(
      REPO,
      PR_NUMBER,
      'La génération QA a échoué — merci d’ajouter les étapes manuellement.'
    )
    await addLabel(REPO, PR_NUMBER, 'qa-generated')
    console.log(`QA generation failed, fallback comment posted for ${REPO}#${PR_NUMBER}`)
    return
  }

  await postComment(REPO, PR_NUMBER, qaComment)
  await addLabel(REPO, PR_NUMBER, 'qa-generated')

  console.log(`QA steps generated for ${REPO}#${PR_NUMBER}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
