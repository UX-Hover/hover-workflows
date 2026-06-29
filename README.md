# hover-workflows

Central GitHub Actions automation for Hover PRs, running on a self-hosted runner.

- Add label `description` to a PR → its body is auto-generated from the diff.
- Add label `ready for qa` to a PR → a QA comment (human checklist + QA bot YAML) is posted.

No web server, no database, no Docker. GitHub Actions is the runtime; logic lives here and is
called by every client repo via `workflow_call`.

## How it works

```
UX-HOVER/hover-workflows/          ← this repo
├── .github/workflows/
│   ├── pr-description.yml         ← reusable workflow (workflow_call)
│   └── pr-qa.yml                  ← reusable workflow (workflow_call)
├── scripts/
│   ├── generate-description.js
│   ├── generate-qa.js
│   └── lib/
│       ├── github.js              ← GitHub REST API calls (native fetch)
│       └── claude.js              ← Claude API wrapper
├── prompts/
│   ├── description.md
│   └── qa.md
└── examples/client-repo/.github/workflows/hover-automation.yml
```

Each client repo only needs a single caller file
(`.github/workflows/hover-automation.yml`, see `examples/client-repo/`) that references this
repo's reusable workflows. Updating logic here propagates to every client repo automatically —
no per-repo changes needed.

Jobs run on `runs-on: self-hosted`, against the runner installed on the VPS
(`167.233.53.77`, install path `/home/mehdi/actions-runner/`). This gives unlimited
minutes and a consistent environment; no inbound ports are opened.

## Onboarding a new client repo

**If the client repo is inside the `UX-Hover` org:**

1. Copy `examples/client-repo/.github/workflows/hover-automation.yml` into the client repo at the
   same path. It calls this repo's reusable workflows via `workflow_call`.
2. Add the `ANTHROPIC_API_KEY` secret to the client repo.
3. Create the labels `description`, `ready for qa`, and `qa-generated`.

**If the client repo is in a different org/account (e.g. a client-owned repo):**

`workflow_call` only works between repos in the same org (or same enterprise account), so a
private reusable workflow can't be called cross-org. Use the standalone template instead — it
checks out this repo's scripts directly via a token rather than calling a reusable workflow, so
the central logic still lives in one place.

This template also runs on `runs-on: ubuntu-latest` (GitHub-hosted) rather than `self-hosted`.
Our self-hosted runner is registered under the `UX-Hover` org and has no visibility into other
orgs — a job with `runs-on: self-hosted` on a cross-org repo will queue forever and silently time
out, since no matching runner will ever pick it up. GitHub-hosted runners work immediately and
cost the *client repo's own* Actions minutes, not ours — fine, since the scripts only read via the
GitHub API and don't depend on local disk access.

1. Copy `examples/client-repo-cross-org/.github/workflows/hover-automation.yml` into the client
   repo at the same path.
2. Create a fine-grained Personal Access Token scoped to **read-only access on this repo only**
   (`UX-Hover/hover-workflows`): GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → select repository → Contents: Read-only.
3. Add that token to the client repo as a secret named `HOVER_WORKFLOWS_TOKEN`.
4. Add the `ANTHROPIC_API_KEY` secret to the client repo.
5. Create the labels `description`, `ready for qa`, and `qa-generated`.

To bulk-add `ANTHROPIC_API_KEY` across many same-org repos:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

gh repo list UX-HOVER --json name -q '.[].name' | xargs -I{} \
  gh secret set ANTHROPIC_API_KEY --repo UX-HOVER/{} --body "$ANTHROPIC_API_KEY"
```

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
