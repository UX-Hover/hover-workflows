import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  fetchPR,
  fetchDiff,
  fetchChangedFiles,
  fetchFileContent,
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
  ].join('\n')

  let qaComment
  try {
    qaComment = await ask(systemPrompt, userPrompt, 3000)
    if (!qaComment || !qaComment.trim()) {
      throw new Error('empty response')
    }
  } catch (err) {
    console.error('Claude QA generation failed:', err)
    await postComment(
      REPO,
      PR_NUMBER,
      'QA generation failed — please add steps manually.'
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
