# Hover PR Automation — Claude Code Handoff

## What we're building

A centralized GitHub Actions automation system hosted on our VPS (`167.233.53.77`) that:

1. **Auto-generates PR descriptions** when a dev adds the label `description` to any PR
2. **Auto-generates QA steps** (for human tester + QA bot) when a dev adds the label `ready for qa`

All logic lives in one internal repo (`hover-internal/workflows`). Each client repo gets a single 10-line caller file. Logic updates propagate to all repos automatically.

---

## Architecture

```
hover-internal/workflows/          ← central repo on GitHub
├── .github/
│   └── workflows/
│       ├── pr-description.yml     ← reusable workflow (workflow_call)
│       └── pr-qa.yml              ← reusable workflow (workflow_call)
├── scripts/
│   ├── generate-description.js
│   ├── generate-qa.js
│   └── lib/
│       ├── github.js              ← all GitHub API calls
│       └── claude.js              ← Claude API wrapper
├── prompts/
│   ├── description.md             ← PR description system prompt
│   └── qa.md                      ← QA generation system prompt
├── package.json
└── README.md
```

Each client repo gets one file:
```
{client-repo}/
└── .github/
    └── workflows/
        └── hover-automation.yml   ← 10-line caller, nothing else
```

**No server. No database. No Docker. No Express.**
GitHub Actions IS the runtime. Scripts run on the Actions runner, not on our VPS directly. The VPS is used only for the self-hosted runner (see below).

---

## Why the VPS

We use a **GitHub Actions self-hosted runner** on the VPS for two reasons:
- Full repo access at checkout (reads files from disk for QA context)
- No GitHub Actions minutes consumed (unlimited on self-hosted)
- Consistent environment across all runs

The runner is a lightweight process on the VPS. No port exposure needed, no web server — it polls GitHub outbound only.

---

## VPS details

- **IP:** `167.233.53.77`
- **OS:** Ubuntu 24
- **User:** `claude` (or whichever non-root user exists)
- **Runner install path:** `/home/claude/actions-runner/`
- **SSH config override:** `/etc/ssh/sshd_config.d/100-custom.conf` (key-based auth, do not touch)

---

## Tech stack

- **Runtime:** Node.js 20 (ESM — `"type": "module"` in package.json)
- **Claude SDK:** `@anthropic-ai/sdk`
- **GitHub API:** native `fetch` (no Octokit — keep deps minimal)
- **No other dependencies**

---

## Step-by-step build plan

### Phase 1 — VPS runner setup

1. SSH into VPS
2. Create a dedicated user for the runner if not already: `useradd -m hover-runner`
3. Download and configure the GitHub Actions self-hosted runner:
   ```bash
   mkdir -p /home/hover-runner/actions-runner && cd /home/hover-runner/actions-runner
   curl -o actions-runner-linux-x64.tar.gz -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
   tar xzf ./actions-runner-linux-x64.tar.gz
   ./config.sh --url https://github.com/hover-internal --token RUNNER_TOKEN_FROM_GITHUB
   ```
4. Install as a systemd service so it survives reboots:
   ```bash
   sudo ./svc.sh install hover-runner
   sudo ./svc.sh start
   ```
5. Verify runner appears as **Idle** in GitHub → Settings → Actions → Runners

> RUNNER_TOKEN_FROM_GITHUB: Go to github.com/orgs/hover-internal/settings/actions/runners → New runner → copy the token shown.

### Phase 2 — Central repo scaffold

Create repo `hover-internal/workflows` on GitHub (private), then build the file structure above.

**`package.json`**
```json
{
  "name": "hover-workflows",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "@anthropic-ai/sdk": "^0.24.0"
  }
}
```

### Phase 3 — `lib/github.js`

Single module for all GitHub API interactions. Must export:

```js
export async function fetchPR(repo, prNumber)
// GET /repos/{repo}/pulls/{prNumber}
// Returns: { title, body, head: { ref } }

export async function fetchDiff(repo, prNumber)
// GET /repos/{repo}/pulls/{prNumber}
// Accept: application/vnd.github.v3.diff
// Returns: raw diff string

export async function fetchChangedFiles(repo, prNumber)
// GET /repos/{repo}/pulls/{prNumber}/files
// Returns: [{ filename, additions, deletions, status }]

export async function fetchFileContent(repo, filePath, ref)
// GET /repos/{repo}/contents/{filePath}?ref={ref}
// Returns: decoded file content string (base64 decode)

export async function postComment(repo, prNumber, body)
// POST /repos/{repo}/issues/{prNumber}/comments

export async function updatePRBody(repo, prNumber, body)
// PATCH /repos/{repo}/pulls/{prNumber}

export async function removeLabel(repo, prNumber, label)
// DELETE /repos/{repo}/issues/{prNumber}/labels/{label}
// Wrap in try/catch — fails silently if label already removed

export async function addLabel(repo, prNumber, label)
// POST /repos/{repo}/issues/{prNumber}/labels
```

All functions read `process.env.GITHUB_TOKEN` internally. Use native `fetch`. Throw on non-2xx with a clear error message including status code.

### Phase 4 — `lib/claude.js`

```js
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function ask(systemPrompt, userPrompt, maxTokens = 2000) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })
  return message.content[0].text
}
```

### Phase 5 — `prompts/description.md`

System prompt for PR description generation. Should instruct Claude to:
- Act as a senior Shopify developer at Hover CRO agency
- Generate a structured PR description in markdown
- Output sections: `## What changed`, `## Why`, `## Areas affected`, `## Testing notes`
- Keep it concise and factual — no fluff
- Areas affected should map to Shopify-specific zones: cart / PDP / collection / header / footer / section name / snippet name / JS component / CSS

### Phase 6 — `prompts/qa.md`

System prompt for QA step generation. Should instruct Claude to:
- Act as a senior Shopify QA engineer familiar with CRO A/B testing
- Read the full diff AND related file context before generating steps
- Output two distinct blocks in one markdown comment:

**Block 1 — `👤 Human QA checklist`**
- Setup instructions (which branch, clear cart, staging URL pattern)
- Visual checks (desktop + mobile explicitly)
- Functional checks (step-by-step user flows with specific actions)
- Edge cases (empty states, no JS, sale prices, OOS, different product types)
- Regression checks (adjacent features that should still work)

**Block 2 — `🤖 QA Bot instructions`**
- Structured YAML block
- Fields: `branch`, `steps[]` (each with `action`, `selector`/`url`/`target`, `assertion`/`expected`)
- Actions: `navigate`, `click`, `check_element`, `assert_text`, `assert_visible`, `fill_input`
- `regression[]` list of pages/flows to smoke test

Footer: `> Generated by Hover QA Bot · PR #{PR_NUMBER} · {timestamp}`

### Phase 7 — `scripts/generate-description.js`

```
1. Read env: REPO, PR_NUMBER (all passed from workflow)
2. fetchPR() + fetchDiff()
3. Slice diff to 80k chars max
4. Read prompts/description.md as system prompt
5. Build user prompt with: PR title, existing body, diff
6. ask(systemPrompt, userPrompt)
7. updatePRBody() with generated description
8. removeLabel('description')
9. console.log success
```

Error handling: wrap in try/catch, log error, process.exit(1) so the Actions job fails visibly.

### Phase 8 — `scripts/generate-qa.js`

```
1. Read env: REPO, PR_NUMBER, HEAD_REF
2. fetchPR() + fetchDiff() + fetchChangedFiles() — parallel with Promise.all
3. For each changed file:
   a. If it's a .liquid file in sections/ snippets/ components/:
      - fetchFileContent() for the full file
      - Parse {% render 'x' %} calls from the content
      - fetchFileContent() for each referenced snippet (deduplicated)
   b. If it's a .js or .js.liquid file: fetchFileContent()
   c. Skip: CSS-only files, config files, .json schema files
4. Cap total related file context at 30k chars (truncate largest files first)
5. Read prompts/qa.md as system prompt
6. Build user prompt with: PR title, PR body, file list, diff (60k max), related files context
7. ask(systemPrompt, userPrompt, 3000)
8. postComment() with generated QA steps
9. addLabel('qa-generated')
10. console.log success
```

### Phase 9 — Reusable workflow files

**`.github/workflows/pr-description.yml`**
```yaml
name: Generate PR Description
on:
  workflow_call:
    secrets:
      ANTHROPIC_API_KEY:
        required: true

jobs:
  generate:
    if: github.event.label.name == 'description'
    runs-on: self-hosted
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
        working-directory: ${{ github.action_path }}/../..
      - run: node scripts/generate-description.js
        working-directory: ${{ github.action_path }}/../..
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REPO: ${{ github.repository }}
```

> Note: `working-directory` needs to point to the checked-out central repo scripts. See implementation note below about checkout strategy.

**`.github/workflows/pr-qa.yml`**
Same structure, different label check (`ready for qa`) and script (`generate-qa.js`), `max_tokens: 3000`.

### Phase 10 — Caller file for client repos

**`{client-repo}/.github/workflows/hover-automation.yml`**
```yaml
name: Hover PR Automation
on:
  pull_request:
    types: [labeled]

jobs:
  pr-description:
    uses: hover-internal/workflows/.github/workflows/pr-description.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

  pr-qa:
    uses: hover-internal/workflows/.github/workflows/pr-qa.yml@main
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

---

## Implementation note — checkout strategy for reusable workflows

When a reusable workflow runs, it executes in the **calling repo's** context. The scripts live in the central repo. Two options:

**Option A (recommended) — checkout both repos**
In the reusable workflow, checkout the central repo explicitly:
```yaml
- uses: actions/checkout@v4
  with:
    repository: hover-internal/workflows
    path: .hover-workflows
    token: ${{ secrets.GITHUB_TOKEN }}
- run: npm ci && node generate-description.js
  working-directory: .hover-workflows/scripts
```
Then also checkout the calling repo (for file reading in QA script):
```yaml
- uses: actions/checkout@v4
  with:
    path: .calling-repo
```

**Option B — inline scripts via `run:` steps**
Copy scripts inline in the workflow YAML. Simpler but harder to maintain. Don't use this.

Go with Option A.

---

## Secrets setup

### On the central repo (`hover-internal/workflows`)
- No secrets needed at repo level — they're passed through from callers

### On each client repo
- `ANTHROPIC_API_KEY` → repo Settings → Secrets → Actions

### Bulk add via GitHub CLI
```bash
export ANTHROPIC_API_KEY="sk-ant-..."

gh repo list hover-org --json name -q '.[].name' | xargs -I{} \
  gh secret set ANTHROPIC_API_KEY --repo hover-org/{} --body "$ANTHROPIC_API_KEY"
```

---

## Diff and context size limits

| Content | Limit | Action when exceeded |
|---|---|---|
| PR diff | 80k chars | Hard truncate with note appended |
| Single related file | 8k chars | Truncate at 8k |
| Total related files context | 30k chars | Drop smallest-value files (CSS-only, config) first |
| Claude response | 2000 tokens (description) / 3000 tokens (QA) | — |

---

## Error handling rules

- Every script: wrap entire execution in `try/catch`, log the error, `process.exit(1)`
- `removeLabel`: always try/catch silently — label may already be gone
- GitHub API non-2xx: throw with status + response body in message
- If Claude returns empty/malformed: post a comment saying "QA generation failed — please add steps manually" rather than failing silently

---

## Labels convention

| Label | Triggers | Added after | Removed after |
|---|---|---|---|
| `description` | PR description generation | — | ✅ After generation (prevents loop) |
| `ready for qa` | QA steps generation | — | Keep (human removes when QA done) |
| `qa-generated` | Downstream signal | ✅ After QA comment posted | — |

Create these labels in each repo (or use the GitHub API to bulk-create them).

---

## Testing the setup

### Test description workflow
1. Open any PR in a client repo
2. Add label `description`
3. Watch Actions tab → job should run in ~20s
4. PR body should be updated with generated description
5. Label `description` should auto-remove

### Test QA workflow
1. Open any PR with at least one `.liquid` or `.js` file changed
2. Add label `ready for qa`
3. Watch Actions tab → job should run in ~30s
4. A comment should appear with `👤 Human QA checklist` and `🤖 QA Bot instructions`
5. Label `qa-generated` should appear

### Verify runner
```bash
# On VPS
cd /home/hover-runner/actions-runner
sudo ./svc.sh status
# Should show: active (running)
```

---

## What NOT to build

- No web server or API endpoint
- No webhook handler
- No database or state storage
- No Docker or containerization
- No cron jobs
- No notification system (GitHub already notifies via the PR comment)
- No dashboard or UI

---

## Done state

The project is done when:
- [ ] Self-hosted runner is live on VPS and shows Idle in GitHub
- [ ] `hover-internal/workflows` repo exists with all files above
- [ ] Adding label `description` to any PR auto-updates the PR body
- [ ] Adding label `ready for qa` to any PR posts a comment with both QA blocks
- [ ] One client repo (`hover-dev/test-repo` or similar) is wired up and tested end-to-end
- [ ] README documents how to onboard a new client repo (two steps: add caller file, add secret)
