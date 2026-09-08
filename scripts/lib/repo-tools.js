import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// Tools the review model can call to explore the FULL checked-out branch.
// The pre-built context dump is a starting point, not a boundary: before the
// model claims "nothing listens to [name=previous]" it can (must) grep the
// whole repo. All execution is local to the workflow's checkout — no network.

const MAX_FILE_CHARS = 120_000
const MAX_GREP_MATCHES = 200
const MAX_LIST_LINES = 2_000

function resolveInside(repoDir, p) {
  const abs = path.resolve(repoDir, p)
  if (abs !== repoDir && !abs.startsWith(repoDir + path.sep)) {
    throw new Error(`path escapes the repository: ${p}`)
  }
  return abs
}

export function buildRepoTools(repoDir) {
  repoDir = path.resolve(repoDir)

  const tools = [
    {
      name: 'read_file',
      description:
        "Lit un fichier de la branche de la PR (chemin relatif à la racine du thème). Retourne le contenu avec numéros de ligne. Utilise start_line/end_line pour un gros fichier.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Chemin relatif, ex: assets/component-slider.js' },
          start_line: { type: 'integer', description: 'Première ligne (1-indexée), optionnel' },
          end_line: { type: 'integer', description: 'Dernière ligne incluse, optionnel' },
        },
        required: ['path'],
      },
    },
    {
      name: 'grep_repo',
      description:
        "Cherche un motif (regex POSIX étendue) dans TOUS les fichiers de la branche. Retourne fichier:ligne:contenu. Sers-t'en pour trouver les consommateurs d'un attribut/classe/event, les bindings JS d'un composant, les customElements.define, etc.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: "Motif regex, ex: name=\\\"previous\\\"|slider-component" },
          glob: { type: 'string', description: "Limiter aux chemins correspondants, ex: assets/*.js (optionnel)" },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'list_files',
      description: 'Liste les fichiers de la branche (optionnellement filtrés par un motif de chemin).',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          glob: { type: 'string', description: "ex: assets/*.js ou snippets/ (optionnel)" },
        },
      },
    },
  ]

  function execute(name, input) {
    if (name === 'read_file') {
      const abs = resolveInside(repoDir, input.path)
      const st = statSync(abs)
      if (!st.isFile()) throw new Error(`not a file: ${input.path}`)
      let lines = readFileSync(abs, 'utf-8').split('\n')
      const total = lines.length
      const start = Math.max(1, input.start_line ?? 1)
      const end = Math.min(total, input.end_line ?? total)
      lines = lines.slice(start - 1, end)
      let out = lines.map((l, i) => `${start + i}\t${l}`).join('\n')
      if (out.length > MAX_FILE_CHARS) {
        out = out.slice(0, MAX_FILE_CHARS) + `\n[tronqué — relis avec start_line/end_line ; fichier: ${total} lignes]`
      }
      return `${input.path} (lignes ${start}-${end} sur ${total})\n${out}`
    }

    if (name === 'grep_repo') {
      const args = ['grep', '-nIE', '--no-color', '-e', input.pattern]
      if (input.glob) args.push('--', input.glob)
      let out
      try {
        out = execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', maxBuffer: 10_000_000 })
      } catch (err) {
        if (err.status === 1) return '(aucun résultat)'
        throw new Error(`grep failed: ${err.message}`)
      }
      const lines = out.split('\n').filter(Boolean)
      const shown = lines.slice(0, MAX_GREP_MATCHES)
      const note = lines.length > shown.length ? `\n[${lines.length - shown.length} résultats de plus — affine le motif ou ajoute un glob]` : ''
      return shown.map((l) => (l.length > 400 ? l.slice(0, 400) + '…' : l)).join('\n') + note
    }

    if (name === 'list_files') {
      const args = ['ls-files']
      if (input.glob) args.push('--', input.glob)
      const out = execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', maxBuffer: 10_000_000 })
      const lines = out.split('\n').filter(Boolean)
      const shown = lines.slice(0, MAX_LIST_LINES)
      const note = lines.length > shown.length ? `\n[${lines.length - shown.length} fichiers de plus]` : ''
      return shown.join('\n') + note
    }

    throw new Error(`unknown tool: ${name}`)
  }

  return { tools, execute }
}
