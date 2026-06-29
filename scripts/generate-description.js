import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fetchPR, fetchDiff, updatePRBody, removeLabel } from './lib/github.js'
import { ask } from './lib/claude.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIFF_LIMIT = 80_000

async function main() {
  const { REPO, PR_NUMBER } = process.env
  if (!REPO || !PR_NUMBER) {
    throw new Error('Missing required env vars: REPO, PR_NUMBER')
  }

  const [pr, diff] = await Promise.all([fetchPR(REPO, PR_NUMBER), fetchDiff(REPO, PR_NUMBER)])

  const truncatedDiff =
    diff.length > DIFF_LIMIT
      ? `${diff.slice(0, DIFF_LIMIT)}\n\n[diff truncated at ${DIFF_LIMIT} chars]`
      : diff

  const systemPrompt = await readFile(path.join(__dirname, '..', 'prompts', 'description.md'), 'utf-8')

  const userPrompt = [
    `PR title: ${pr.title}`,
    '',
    'Existing PR body:',
    pr.body || '(empty)',
    '',
    'Diff:',
    '```diff',
    truncatedDiff,
    '```',
  ].join('\n')

  const description = await ask(systemPrompt, userPrompt)

  await updatePRBody(REPO, PR_NUMBER, description)
  await removeLabel(REPO, PR_NUMBER, 'description')

  console.log(`PR description generated for ${REPO}#${PR_NUMBER}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
