import { parse } from 'yaml'

const SUPPORTED_ACTIONS = new Set(['navigate', 'click', 'check_element', 'assert_text', 'assert_visible'])
const VIEWPORTS = new Set(['desktop', 'mobile', 'both'])
// [produit-opt-in], {staging}, {handle-...}
const URL_PLACEHOLDER_RE = /\[[\w-]+\]|\{[\w-]+\}/
// [section-id], {x}, descriptive pseudo-selectors like [Add to cart button],
// or any bracket containing an unquoted space (real CSS attribute selectors quote their values)
const SELECTOR_PLACEHOLDER_RE = /\[(section-id|block-id)\]|\{[\w-]+\}|\[[A-Z][^\]]*\]|\[[^\]"']*\s[^\]"']*\]/
const CONDITIONAL_RE = /\bsi\b|\bsinon\b|\bselon\b/i
// Absence assertions the bot can't reliably confirm in a step (only presence is
// reliable) — route these to `regression` instead.
const ABSENCE_RE = /\babsente?s?\b|\bmasqué\w*\b|\bcaché\w*\b|\bdispara\w+|n'(?:est|sont|apparai\w+)\s+(?:pas|plus)\b|\bne\s+(?:s'affiche\w*|doit|doivent|devrait\w*|sont)\s+(?:pas|plus)\b/i
// A source filename in a regression line ("main-product.liquid"). The executor
// pulls CSS selectors out of the line with /\.[\w-]{6,}/ (yaml-runner.js), so
// `.liquid` is queried as an element, never found, and the whole regression is
// reported as a failure. Other extensions are under the 6-char threshold today,
// but a regression line names a storefront behaviour, not a source file.
const FILE_EXT_RE = /\.(liquid|scss|css|js|json|ts|tsx|jsx|html)\b/i

// Wording that describes the diff instead of the expected user-facing result.
// Its presence proves the assertion was copied from the changed code rather than
// derived from intent — the artifact then passes on broken code and fails once fixed.
const DIFF_REFERENTIAL_RE = new RegExp(
  [
    'nouvelle?\\s+classe',
    'dans\\s+le\\s+diff', // "hardcodé dans le diff", "modifié dans le diff", "comme dans le diff"
    'renomm(?:é|ee|ée)s?\\s+depuis',
    'r(?:é|e)gressions?\\s+(?:depuis|visuelles?|intentionnelles?|volontaires?)',
    '(?:volontaire|intentionnel)(?:le)?s?\\b',
    'hardcod(?:é|ee|ée)s?\\b',
    '(?:modifi|ajout|appliqu|introduit)(?:é|ee|ée)s?\\s+(?:dans|par)\\s+(?:cette\\s+|la\\s+)?PR',
    'valeurs?\\s+(?:actuelles?|du\\s+diff)',
  ].join('|'),
  'i'
)

export function lintQaYaml(
  markdown,
  { allowedHandles = [], hasSchemaSettings = false, sectionViews = null } = {}
) {
  const allowed = new Set(allowedHandles)
  // Views whose template actually contains a changed section. Null/empty means
  // "unknown" (e.g. a global section like the header or cart drawer) — no check.
  const knownViews = Array.isArray(sectionViews) && sectionViews.length ? new Set(sectionViews) : null
  const fence = markdown.match(/```ya?ml\n([\s\S]*?)```/)
  if (!fence) return { errors: ['no fenced YAML block found in the output'] }

  // The contract is "only the YAML block and the footer". Prose before the fence
  // is usually the model narrating its retry loop, and it ships to the PR comment.
  const preamble = markdown.slice(0, markdown.indexOf(fence[0])).trim()
  if (preamble.length > 0) {
    return {
      errors: [
        `output starts with ${preamble.length} chars of prose before the YAML fence — emit ONLY the fenced YAML block and the footer (offending start: "${preamble.slice(0, 80)}…")`,
      ],
    }
  }

  let doc
  try {
    doc = parse(fence[1])
  } catch (err) {
    return { errors: [`YAML parse error: ${err.message}`] }
  }
  if (!doc || !Array.isArray(doc.steps) || doc.steps.length === 0) {
    return { errors: ['YAML has no `steps` list'] }
  }

  const errors = []
  doc.steps.forEach((step, i) => {
    const at = `steps[${i}] (${step.action ?? 'no action'})`
    if (!SUPPORTED_ACTIONS.has(step.action)) {
      errors.push(`${at}: unsupported action — allowed: ${[...SUPPORTED_ACTIONS].join(', ')}`)
    }
    if (!VIEWPORTS.has(step.viewport)) {
      errors.push(`${at}: viewport must be desktop, mobile or both (got "${step.viewport}")`)
    }
    // The runner resolves the page per step from `view` — a step without it is
    // untestable (it would run against an unknown page and false-fail).
    if (!('view' in step)) {
      errors.push(
        `${at}: missing \`view\` — every step must declare the template view it runs against (\`view: null\` for the default template)`
      )
    } else if (step.view !== null && (typeof step.view !== 'string' || !step.view.trim())) {
      errors.push(`${at}: \`view\` must be null or a non-empty view suffix string (got "${step.view}")`)
    } else if (knownViews && step.view !== null && !knownViews.has(String(step.view))) {
      // Testing a changed section on a template that does not contain it means
      // the element is never rendered — every assertion fails for the wrong reason.
      errors.push(
        `${at}: view "${step.view}" is not among the templates that contain the changed section(s) [${[...knownViews].join(', ')}] — the changed code does not render there, so these steps fail regardless of code quality. Use one of those views, or move the check to regression`
      )
    }
    // The runner resolves the page from `view`; a url carrying a different
    // ?view= silently tests another template while lint sees both as valid.
    if (step.url) {
      const urlView = step.url.match(/[?&]view=([\w.-]+)/)
      const declared = step.view === null || step.view === undefined ? null : String(step.view)
      if (urlView && urlView[1] !== declared) {
        errors.push(
          `${at}: url declares ?view=${urlView[1]} but the step's \`view\` is ${declared === null ? 'null' : `"${declared}"`} — they must match (the runner navigates from \`view\`)`
        )
      }
      if (!urlView && declared !== null && step.url.includes('/products/')) {
        errors.push(
          `${at}: \`view: "${declared}"\` but the url has no ?view=${declared} suffix — a non-default template must be loaded with its preview suffix`
        )
      }
    }
    if (step.action === 'navigate') {
      if (!step.url) {
        errors.push(`${at}: navigate step without url`)
      } else if (URL_PLACEHOLDER_RE.test(step.url)) {
        errors.push(
          `${at}: placeholder in url "${step.url}" — use a real handle from the qa block of project-specs.md, or move the check to regression`
        )
      } else if (allowed.size) {
        const m = step.url.match(/\/products\/([\w.-]+)/)
        if (m && !allowed.has(m[1])) {
          errors.push(
            `${at}: product handle "${m[1]}" is not in the qa block of project-specs.md — allowed handles: ${[...allowed].join(', ')}`
          )
        }
      }
    } else {
      if (!step.selector) {
        errors.push(`${at}: ${step.action} step without selector`)
      } else if (SELECTOR_PLACEHOLDER_RE.test(step.selector)) {
        errors.push(
          `${at}: placeholder selector "${step.selector}" — resolve a real selector from the branch code, or move the check to regression`
        )
      }
    }
    const freeText = `${step.assertion ?? ''} ${step.expected ?? ''}`
    if (DIFF_REFERENTIAL_RE.test(freeText)) {
      errors.push(
        `${at}: assertion describes the diff instead of the expected result ("${(step.assertion || step.expected || '').slice(0, 80)}") — this proves it was copied from the changed markup, so it passes on broken code and fails once fixed. Assert the INTENDED user-facing state (from schema labels, locale strings, CSS-defined classes, PR intent), or move the doubt to regression`
      )
    }
    // "ne produit pas d'erreur" / "n'affiche aucun" are absence checks the
    // ABSENCE_RE vocabulary misses.
    if (/\bne\s+(?:produit|génère|declenche|déclenche|renvoie)\s+(?:pas|aucune?)\b|\bn'affiche\s+aucune?\b|\bsans\s+erreur\b/i.test(freeText)) {
      errors.push(
        `${at}: "no error / nothing shown" is an absence check — a step only reliably confirms presence; move it to regression`
      )
    }
    if (CONDITIONAL_RE.test(freeText)) {
      errors.push(
        `${at}: conditional assertion "${(step.assertion || step.expected || '').slice(0, 80)}" — split into two steps on two distinct products from the qa block`
      )
    }
    if (ABSENCE_RE.test(freeText)) {
      errors.push(
        `${at}: absence assertion "${(step.assertion || step.expected || '').slice(0, 80)}" — a step only reliably confirms presence; move any "should be absent/hidden/removed" check to regression`
      )
    }
  })

  // settings_matrix is the main lever for reaching config-driven defects; an
  // empty one while the section declares settings means the schema never made it
  // into context (see the schema-aware truncation in qa-context.js).
  if (hasSchemaSettings) {
    const matrix = doc.settings_matrix
    if (!Array.isArray(matrix) || matrix.length === 0) {
      errors.push(
        '`settings_matrix` is empty but the section/block schema declares settings — enumerate every provided setting with its full set of values to test'
      )
    }
  }

  // Each regression entry must be a plain string. A ": " inside an unquoted list
  // item makes YAML parse it as a mapping, which crashes the executor's
  // regression pass (regText.match is not a function) after the steps have run.
  if (doc.regression != null) {
    if (!Array.isArray(doc.regression)) {
      errors.push('`regression` must be a list of plain one-line strings')
    } else {
      doc.regression.forEach((r, i) => {
        if (typeof r !== 'string') {
          errors.push(
            `regression[${i}]: must be a plain one-line string — a ": " made YAML parse it as a mapping; rephrase without ": " (use a dash) or quote the whole line`
          )
          return
        }
        // The same poison as in steps: a regression line that certifies the
        // changed value ("vérifier que X vaut magenta", "régression volontaire")
        // turns the reviewer into a rubber stamp for the bug.
        if (DIFF_REFERENTIAL_RE.test(r)) {
          errors.push(
            `regression[${i}]: describes the diff as the expected result ("${r.slice(0, 90)}") — regression entries are doubts to investigate or flows to smoke-test, never a changelog certifying the new values. Rephrase as a question about the intended behaviour`
          )
        }
        if (FILE_EXT_RE.test(r)) {
          errors.push(
            `regression[${i}]: names a source file ("${r.slice(0, 90)}") — the executor reads the extension as a CSS selector and reports the check as failed. Describe the storefront behaviour, or name the section, without any file path or extension`
          )
        }
      })
    }
  }

  return { errors }
}
