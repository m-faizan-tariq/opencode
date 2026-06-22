# Upstream Sync Guide

## Remotes
- `origin`  → your fork (`https://github.com/m-faizan-tariq/opencode.git`)
- `upstream` → official OpenCode (`https://github.com/anomalyco/opencode.git`)

> Note: The upstream repo moved from `sst/opencode` to `anomalyco/opencode` in Jan 2026.

## Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Clean mirror of `upstream/dev` — never commit custom work here |
| `fix/bundle-aware-listing` | All custom changes — always rebased on top of `main` |

The upstream project uses `dev` as its primary development branch (not `main`).
Our `main` tracks `upstream/dev` so it receives all upstream updates.

## Custom Commits to Preserve

These are your custom commits on `fix/bundle-aware-listing`. They must survive every rebase:

1. `fix(skills): hide bundle sub-skills from /skills listing`
2. `fix(skills): resolve symlink dedup and wire available() in HTTP handler`
3. `feat(skills): native install flow with directory and GitHub support`

## How to Pull a New Upstream Release

Run these commands every time the official OpenCode releases an update:

```bash
# 1. Fetch latest upstream
git fetch upstream --prune --tags

# 2. Update local main to match upstream/dev
git checkout main
git rebase upstream/dev
git push origin main --force-with-lease

# 3. Rebase your custom branch on updated main
git checkout fix/bundle-aware-listing
git rebase main

# 4. If conflicts appear — resolve them, then:
git add <resolved-file>
git rebase --continue

# 5. Push updated custom branch
git push origin fix/bundle-aware-listing --force-with-lease

# 6. Run tests
cd packages/opencode && bun test test/skill/

# 7. Rebuild and promote binary
cd packages/opencode && bun run build
cp dist/opencode-darwin-arm64/bin/opencode ~/.opencode/bin/opencode
```

## Automation

A GitHub Actions workflow (`.github/workflows/sync-upstream.yml`) runs daily at 6 AM UTC
to keep `main` in sync with `upstream/dev` automatically.
You still need to manually rebase `fix/bundle-aware-listing` onto `main` after that.

## If Rebase Fails

```bash
git rebase --abort   # undo the rebase completely
```

Then inspect the conflicts manually before retrying.
