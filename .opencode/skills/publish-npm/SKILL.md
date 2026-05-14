---
name: publish-npm
description: Publish @openplaw/openplaw to npm with the correct build → publish flow. NEVER npm publish from source directly — always build first. Use this skill whenever the user asks to publish, release, or bump the npm package version.
---

# Publish @openplaw/openplaw to npm

## Critical Rule

**NEVER `npm publish` directly without building first.** The source code must be compiled via `tsc` to produce the `dist/` directory that npm ships. Publishing without building results in a broken package.

The correct flow requires 4 steps — use the automation script or follow the manual steps below.

## Automation Script

```bash
./publish-npm.sh <version>
# Example: ./publish-npm.sh 0.2.0
```

The script handles all 4 steps automatically. It also checks if the version is already published on npm to avoid re-publishing errors.

## Manual Steps (if script fails)

### Step 1: Bump version in package.json

Edit `package.json` — change `"version"` field. Version numbers **cannot be reused** even after `npm unpublish`.

```bash
# Quick method:
python3 -c "
import json
with open('package.json') as f:
    pkg = json.load(f)
pkg['version'] = '<version>'
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
"
```

### Step 2: Build

```bash
npm run build
```

This compiles TypeScript source to `dist/` via `tsc`. The postinstall script (`dist/scripts/postinstall.js`) creates `~/.openplaw/` and `~/.config/openplaw/` directories on the user's machine after install.

### Step 3: Publish

```bash
npm publish --access public --tag latest --tag latest
```

The `files` field in package.json controls what gets published:
- `dist/` — compiled JS + postinstall script
- `web/dist/` — web management UI
- `scripts/` — utility scripts
- `extensions/` — channel extensions
- `agents/` — built-in agent definitions
- `README.md`

### Step 4: Git commit + push version bump

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to <version>"
git push
```

## Package Structure

```
openplaw (npm package)              ← npm i -g @openplaw/openplaw
  ├── dist/cli/index.js (bin)       ← CLI entry point
  ├── dist/scripts/postinstall.js   ← creates ~/.openplaw/ + ~/.config/openplaw/
  ├── dist/                          ← compiled TypeScript
  ├── web/dist/                      ← web management UI
  ├── extensions/                    ← channel plugin definitions
  └── agents/                        ← built-in agent definitions
```

## Directory Auto-Creation on Install

When a user runs `npm i -g openplaw`, the postinstall script automatically creates:

**Data directory** (`~/.openplaw/` or `$OPENMO_HOME`):
- `agents/` — built-in agent definitions
- `mcp/` — built-in MCP configs
- `skills/` — built-in skills

**Config directory** (`~/.config/openplaw/` or `$OPENMO_CONFIG_HOME`):
- `openplaw.json` — main config (empty `{}`)
- `opencode.json` — opencode config (empty `{}`)
- `omo.json` — omo config (empty `{}`)
- `agents/` — user custom agents
- `mcp/` — user custom MCP configs
- `skills/` — user custom skills
- `credentials/` — channel credentials

## Version Numbers

- npm package version = user-facing version (e.g. `0.2.0`)
- **npm prohibits re-publishing the same version string** even after unpublish. Always bump to a new version.
- Use semver: patch for bug fixes, minor for features, major for breaking changes.

## Common Issues

- **Build errors**: Run `tsc --noEmit` to check for type errors before publishing.
- **npm publish 403**: You may not have permission to publish the `openplaw` package name. Check npm account access.
- **Missing dist/**: Always run `npm run build` before `npm publish`. The `files` field only ships `dist/`, not source.
- **postinstall fails on user machine**: The postinstall script exits with code 0 even on failure (`|| true`) to not block npm install. Directories will be created on first `openplaw start` run instead.