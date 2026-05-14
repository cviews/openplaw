#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?用法: ./publish-npm.sh <version> [--tag <tag>] [--dry-run]}"
TAG="latest"
DRY_RUN=false

for arg in "${@:2}"; do
  case "$arg" in
    --tag)   TAG="${2:-latest}" ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

PKG_NAME="@openplaw/openplaw"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "=== Publishing ${PKG_NAME}@${VERSION} ==="
echo ""

echo "📌 Step 1: Bump version to ${VERSION}"
python3 -c "
import json
with open('${DIR}/package.json') as f:
    pkg = json.load(f)
pkg['version'] = '${VERSION}'
with open('${DIR}/package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')
"

# Check if already published
if npm view "${PKG_NAME}@${VERSION}" version 2>/dev/null | grep -q "${VERSION}"; then
  echo "already published ${PKG_NAME}@${VERSION} — skipping"
  exit 0
fi

echo "🔨 Step 2: Build (tsc)"
cd "$DIR"
npm run build

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "--- Dry run complete. Skipping publish and git push. ---"
  echo "Version bumped to ${VERSION}, build succeeded."
  exit 0
fi

echo "📦 Step 3: npm publish --tag ${TAG}"
npm publish --access public --tag "${TAG}"

echo "📝 Step 4: git commit + push version bump"
cd "$DIR"
git add package.json package-lock.json
git commit -m "chore: bump version to ${VERSION}"
git push

echo ""
echo "✅ Done! ${PKG_NAME}@${VERSION} published to npm"
echo "   Install: npm i -g @openplaw/openplaw"