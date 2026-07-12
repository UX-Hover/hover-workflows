import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fetchPR, fetchDiff, fetchChangedFiles, postComment, addLabel } from './lib/github.js'
import { buildQaUserPrompt } from './lib/qa-context.js'
import { lintQaYaml } from './lib/lint-qa-yaml.js'
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

  const systemPrompt = await readFile(path.join(__dirname, '..', 'prompts', 'qa-bot.md'), 'utf-8')

  let botInstructions
  try {
    botInstructions = await ask(systemPrompt, userPrompt, 16000)
    if (!botInstructions || !botInstructions.trim()) {
      throw new Error('empty response')
    }
  } catch (err) {
    console.error('Claude bot QA generation failed:', err)
    await postComment(
      REPO,
      PR_NUMBER,
      'La génération des instructions QA Bot a échoué — merci d’ajouter les étapes manuellement.'
    )
    await addLabel(REPO, PR_NUMBER, 'qa-generated')
    console.log(`Bot QA generation failed, fallback comment posted for ${REPO}#${PR_NUMBER}`)
    return
  }

  let { errors } = lintQaYaml(botInstructions)
  if (errors.length) {
    console.log(`Lint failed (${errors.length} error(s)), retrying once with feedback`)
    const retryPrompt = [
      userPrompt,
      '',
      'Your previous output failed validation. Fix every error below and output the corrected YAML block (full output, same format):',
      ...errors.map((e) => `- ${e}`),
      '',
      'Previous output:',
      botInstructions,
    ].join('\n')
    botInstructions = await ask(systemPrompt, retryPrompt, 16000)
    errors = lintQaYaml(botInstructions).errors
  }

  if (errors.length) {
    console.error('QA YAML failed lint after retry:')
    for (const e of errors) console.error(`- ${e}`)
    await postComment(
      REPO,
      PR_NUMBER,
      [
        ':warning: Instructions QA générées mais non conformes après relance : label `qa-generated` non posé, la QA automatique ne tournera pas sur ce YAML.',
        '',
        'Erreurs de validation :',
        ...errors.map((e) => `- ${e}`),
        '',
        botInstructions,
      ].join('\n')
    )
    process.exit(1)
  }

  await postComment(REPO, PR_NUMBER, botInstructions)
  await addLabel(REPO, PR_NUMBER, 'qa-generated')

  console.log(`QA bot instructions generated for ${REPO}#${PR_NUMBER}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
