# hover-workflows

Central GitHub Actions automation for Hover PRs, running on a self-hosted runner.

- Add label `description` to a PR → its body is auto-generated from the diff.
- Add label `ready for qa` to a PR → a QA comment (human checklist + QA bot YAML) is posted.

No web server, no database, no Docker. GitHub Actions is the runtime; logic lives here and is
called by every client repo via `workflow_call`.

## Repo layout

```
UX-HOVER/hover-workflows/          ← this repo
├── .github/workflows/
│   ├── pr-description.yml         ← reusable workflow (workflow_call) — same-org repos only
│   └── pr-qa.yml                  ← reusable workflow (workflow_call) — same-org repos only
├── scripts/
│   ├── generate-description.js
│   ├── generate-qa.js
│   └── lib/
│       ├── github.js              ← GitHub REST API calls (native fetch)
│       └── claude.js              ← Claude API wrapper
├── prompts/
│   ├── description.md
│   └── qa.md
├── examples/client-repo/.github/workflows/hover-automation.yml             ← same-org caller
└── examples/client-repo-cross-org/.github/workflows/hover-automation.yml   ← cross-org caller
```

There is exactly one source of truth for the actual logic: `scripts/` and `prompts/` in this
repo. Every client repo only ever carries a thin trigger file
(`.github/workflows/hover-automation.yml`) that either calls into this repo (same-org) or checks
it out at runtime (cross-org). The trigger file's shape differs between the two cases — that's
the only thing that differs.

## How it works, end to end

Both cases start the same way: a human adds the label `description` or `ready for qa` to a PR on
a client repo. GitHub fires a `pull_request` `labeled` event. From there, the two cases diverge
in **where the job runs** and **how it gets the scripts** — everything after that (which script
runs, what it does, what it posts back) is identical.

### Case 1 — client repo lives inside the `UX-Hover` org

```
Dev adds label "description" on UX-Hover/some-client-repo PR
        │
        ▼
some-client-repo's .github/workflows/hover-automation.yml fires
        │  (uses: UX-Hover/hover-workflows/.github/workflows/pr-description.yml@main)
        ▼
GitHub resolves the reusable workflow — allowed because both repos are
owned by the same org, so the private hover-workflows repo is reachable
        │
        ▼
Job runs on runs-on: self-hosted → picked up by our runner on the VPS
(registered under the UX-Hover org, so it's visible to every UX-Hover repo)
        │
        ▼
actions/checkout pulls hover-workflows@main, npm ci, then:
node scripts/generate-description.js
        │  env: ANTHROPIC_API_KEY, GITHUB_TOKEN (auto), PR_NUMBER, REPO
        ▼
Script calls the GitHub REST API (fetchPR, fetchDiff) to read the PR,
sends it to Claude with prompts/description.md as the system prompt,
then calls updatePRBody() to rewrite the PR body and removeLabel()
to remove "description" so it can't re-trigger itself
        │
        ▼
PR body is updated. Done — no human ever leaves the PR page.
```

The `ready for qa` path is identical except: it triggers `pr-qa.yml`, runs
`generate-qa.js` (which additionally fetches changed files, related snippets, section
schemas, metafield references, and templates — see "Limits" below), and ends by
posting a comment and adding the `qa-generated` label instead of editing the PR body.

**Why this works:** `workflow_call` (a "reusable workflow") is GitHub's mechanism for one repo
to invoke a workflow defined in another repo, but it only resolves if the called repo is private
**and** owned by the same org/enterprise as the caller, or if the called repo is public. Since
`hover-workflows` and the client repo are both under `UX-Hover`, this is allowed.

**Why `self-hosted` works here:** our runner was registered with
`./config.sh --url https://github.com/UX-Hover --token ...`, which scopes it to the `UX-Hover`
org specifically. Any repo in that org can use `runs-on: self-hosted` and this runner will pick
up the job. No Actions minutes are consumed since it's our own VPS hardware, not GitHub's.

### Case 2 — client repo lives in a different org/account (e.g. a client-owned repo)

```
Dev adds label "description" on SomeOtherOrg/client-repo PR
        │
        ▼
client-repo's .github/workflows/hover-automation.yml fires
        │  (this file is NOT a thin caller — it's a full standalone job,
        │   because workflow_call across orgs to a private repo is blocked
        │   by GitHub outright, with no workaround)
        ▼
Job runs on runs-on: ubuntu-latest → a GitHub-hosted runner, billed to
client-repo's own Actions minutes (our self-hosted runner is scoped to
UX-Hover only and has no visibility into SomeOtherOrg — using
self-hosted here would queue the job forever with no runner to pick it up)
        │
        ▼
actions/checkout fetches UX-Hover/hover-workflows directly into this job,
authenticated with a fine-grained PAT (secrets.HOVER_WORKFLOWS_TOKEN)
that grants read-only Contents access to that one private repo —
this is what stands in for the same-org trust relationship from Case 1
        │
        ▼
npm ci, then: node scripts/generate-description.js
        │  env: ANTHROPIC_API_KEY, GITHUB_TOKEN (auto, scoped to client-repo
        │       only — never touches hover-workflows), PR_NUMBER, REPO
        ▼
Same script, same prompts, same Claude call, same GitHub API calls
back against client-repo (PR body update / QA comment + label) —
identical behavior to Case 1 from this point on
```

**Why `workflow_call` can't be used here:** GitHub's reusable workflow feature is explicitly
restricted to same-org/enterprise callers when the called workflow lives in a private repo. There
is no token or permission that overrides this — it's a platform-level rule, not a permissions
gap. The only way around it is to not use `workflow_call` at all, which is why this case uses a
plain `actions/checkout` with a PAT instead — `checkout` has no such cross-org restriction, it
just needs a token with read access to the target repo.

**Why `GITHUB_TOKEN` (no secrets prefix needed beyond `secrets.`) still works for posting back to
client-repo:** that token is auto-generated per workflow run by GitHub and scoped to the repo the
workflow is running in — i.e. `client-repo` — regardless of which org owns it. It's unrelated to
the `HOVER_WORKFLOWS_TOKEN` PAT, which exists only to read `hover-workflows`.

## Step-by-step setup

### Case 1 — same-org client repo

1. Copy `examples/client-repo/.github/workflows/hover-automation.yml` into the client repo, same
   path: `.github/workflows/hover-automation.yml`.
2. Add secret `ANTHROPIC_API_KEY` to the client repo (Settings → Secrets and variables →
   Actions → New repository secret).
3. Create labels `description`, `ready for qa`, `qa-generated` on the client repo.
4. Open a PR, add the `description` label, confirm a run appears under the repo's Actions tab
   and the PR body updates within ~30s.

Nothing else is needed — the org-level self-hosted runner and the reusable workflows are already
shared infrastructure.

### Case 2 — cross-org / client-owned repo

1. Copy `examples/client-repo-cross-org/.github/workflows/hover-automation.yml` into the client
   repo, same path: `.github/workflows/hover-automation.yml`. Note it uses
   `runs-on: ubuntu-latest`, not `self-hosted`.
2. Create a fine-grained PAT scoped to **only** `UX-Hover/hover-workflows`, permission
   `Contents: Read-only` (plus the required `Metadata: Read-only`, nothing else — no
   `Pull requests` permission, and don't add any other repo to its access list):
   GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → New
   token → Resource owner: `UX-Hover` → Repository access: Only select repositories →
   `hover-workflows`.
3. Add that token to the **client repo** as a secret named `HOVER_WORKFLOWS_TOKEN`.
4. Add secret `ANTHROPIC_API_KEY` to the client repo (separate from the PAT above).
5. Create labels `description`, `ready for qa`, `qa-generated` on the client repo.
6. Confirm GitHub Actions is actually enabled for that repo/org —
   Settings → Actions → General → "Actions permissions" should allow running workflows. This is
   sometimes locked at the org level and only visible to an org owner on the client's side, not
   to repo admins. If you can't see this page yourself, ask someone on the client's side to
   check it; a correctly-written workflow file will sit silently inactive (no runs, ever) if this
   is restrictive, with no error shown anywhere on our end.
7. Open a PR, add the `description` label, confirm a run appears under the repo's Actions tab
   (this time on a GitHub-hosted runner) and the PR body updates within ~30–60s.

To bulk-add `ANTHROPIC_API_KEY` across many same-org repos:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

gh repo list UX-HOVER --json name -q '.[].name' | xargs -I{} \
  gh secret set ANTHROPIC_API_KEY --repo UX-HOVER/{} --body "$ANTHROPIC_API_KEY"
```

### Troubleshooting checklist (either case)

If no run appears at all after labeling a PR:
1. Confirm the workflow file is on the repo's **default branch** (it won't trigger from an
   unmerged branch/PR).
2. Check Actions → "All workflows" in the sidebar — does `Hover PR Automation` show up there at
   all, with or without a warning icon?
3. Check Settings → Actions → General → "Actions permissions" — if you can't see this page,
   that's itself a signal: org-level policy may be blocking Actions and only an org owner can
   see/change it.
4. (Case 1 only) Confirm the runner shows **Idle** at
   `github.com/orgs/UX-HOVER/settings/actions/runners`.
5. (Case 2 only) Confirm `runs-on: ubuntu-latest`, not `self-hosted` — our runner has no
   visibility outside the `UX-Hover` org and a `self-hosted` job there will queue forever and
   silently time out with no error.

If a run appears but the job fails, check the job log for the failing step — `npm ci` failures
usually mean the `HOVER_WORKFLOWS_TOKEN` (Case 2) is missing/expired/wrongly scoped; script
failures usually mean `ANTHROPIC_API_KEY` is missing or the GitHub API call hit a permissions
error (check `permissions:` in the workflow file grants `pull-requests: write`).

## Labels

| Label | Triggers | Added after | Removed after |
|---|---|---|---|
| `description` | PR description generation | — | ✅ after generation (prevents re-trigger loop) |
| `ready for qa` | QA steps generation | — | kept — human removes once QA is done |
| `qa-generated` | downstream signal | ✅ after QA comment posted | — |

## Limits

| Content | Limit |
|---|---|
| PR diff | 80k chars (description) / 60k chars (QA) |
| Single related file (QA) | 8k chars |
| Total related files context (QA) | 30k chars |
| Claude response | 2000 tokens (description) / 4000 tokens (QA) |

## Local development

```bash
npm ci
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... REPO=org/repo PR_NUMBER=123 \
  node scripts/generate-description.js

GITHUB_TOKEN=... ANTHROPIC_API_KEY=... REPO=org/repo PR_NUMBER=123 HEAD_REF=my-branch \
  node scripts/generate-qa.js
```

## Runner setup (VPS)

Org-level self-hosted runner for `UX-HOVER`, installed under the `mehdi` user's home directory.
Get a registration token from `github.com/orgs/UX-HOVER/settings/actions/runners` → New runner.

```bash
mkdir -p /home/mehdi/actions-runner && cd /home/mehdi/actions-runner
curl -o actions-runner-linux-x64.tar.gz -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
tar xzf ./actions-runner-linux-x64.tar.gz
./config.sh --url https://github.com/UX-HOVER --token RUNNER_TOKEN_FROM_GITHUB
sudo ./svc.sh install mehdi
sudo ./svc.sh start
```

Verify status with `sudo ./svc.sh status` (should show `active (running)`) and confirm the
runner shows **Idle** under the org's Settings → Actions → Runners.
