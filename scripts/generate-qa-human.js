import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fetchPR, fetchDiff, fetchChangedFiles, postComment, addLabel } from './lib/github.js'
import { buildQaUserPrompt } from './lib/qa-context.js'
import { ask } from './lib/claude.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

  const { userPrompt } = await buildQaUserPrompt({
    repo: REPO,
    prNumber: PR_NUMBER,
    headRef: HEAD_REF,
    pr,
    diff,
    changedFiles,
  })

  const systemPrompt = await readFile(path.join(__dirname, '..', 'prompts', 'qa-human.md'), 'utf-8')

  let checklist
  try {
    checklist = await ask(systemPrompt, userPrompt, 16000)
    if (!checklist || !checklist.trim()) {
      throw new Error('empty response')
    }
  } catch (err) {
    console.error('Claude human QA generation failed:', err)
    await postComment(
      REPO,
      PR_NUMBER,
      'La génération de la checklist QA humaine a échoué — merci d’ajouter les étapes manuellement.'
    )
    await addLabel(REPO, PR_NUMBER, 'human-qa-generated')
    console.log(`Human QA generation failed, fallback comment posted for ${REPO}#${PR_NUMBER}`)
    return
  }

  await postComment(REPO, PR_NUMBER, checklist)
  await addLabel(REPO, PR_NUMBER, 'human-qa-generated')

  console.log(`Human QA checklist generated for ${REPO}#${PR_NUMBER}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
