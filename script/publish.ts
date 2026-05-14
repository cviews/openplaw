#!/usr/bin/env node

/**
 * openplaw publish script — bumps version, builds, and publishes to npm.
 *
 * Usage: node script/publish.ts <version> [--dry-run] [--tag <tag>]
 *
 * Steps:
 *   1. Update version in package.json
 *   2. Run npm run build (tsc)
 *   3. npm publish --access public --tag <tag>
 *   4. Git commit + push version bump
 *
 * --dry-run: perform steps 1-2 only, skip publish and git push
 * --tag: npm dist-tag (default: latest)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(dir, "..");
const pkgPath = resolve(projectDir, "package.json");

function parseArgs(): { version: string; dryRun: boolean; tag: string } {
  const argv = process.argv.slice(2);
  const version = argv[0];
  if (!version) {
    console.error("Usage: node script/publish.ts <version> [--dry-run] [--tag <tag>]");
    console.error("Example: node script/publish.ts 0.2.0 --tag beta");
    process.exit(1);
  }
  const dryRun = argv.includes("--dry-run");
  const tagIdx = argv.indexOf("--tag");
  const tag = tagIdx >= 0 && argv[tagIdx + 1] ? argv[tagIdx + 1]! : "latest";
  return { version, dryRun, tag };
}

function run(cmd: string, cwd?: string): void {
  console.log(`  > ${cmd}`);
  execSync(cmd, { cwd: cwd ?? projectDir, stdio: "inherit" });
}

function npmViewVersion(name: string, version: string): boolean {
  try {
    const result = execSync(`npm view ${name}@${version} version`, {
      cwd: projectDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    return result === version;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { version, dryRun, tag } = parseArgs();

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name: string; version: string };
  const pkgName = pkg.name;

  console.log(`\n=== Publishing ${pkgName}@${version} ===\n`);

  // Step 1: Check if already published
  if (npmViewVersion(pkgName, version)) {
    console.log(`already published ${pkgName}@${version} — skipping`);
    process.exit(0);
  }

  // Step 2: Bump version in package.json
  console.log(`\n📌 Step 1: Bump version to ${version}`);
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

  // Step 3: Build
  console.log("\n🔨 Step 2: Build (tsc)");
  run("npm run build");

  if (dryRun) {
    console.log("\n--- Dry run complete. Skipping publish and git push. ---");
    console.log(`Version bumped to ${version}, build succeeded.`);
    process.exit(0);
  }

  // Step 4: Publish
  console.log(`\n📦 Step 3: npm publish --tag ${tag}`);
  run(`npm publish --access public --tag ${tag}`);

  // Step 5: Git commit + push
  console.log("\n📝 Step 4: git commit + push");
  run("git add package.json package-lock.json");
  run(`git commit -m "chore: bump version to ${version}"`);
  run("git push");

  console.log(`\n✅ Done! ${pkgName}@${version} published to npm`);
  console.log(`   Install: npm i -g @openplaw/openplaw`);
}

main().catch((err) => {
  console.error("Publish failed:", err);
  process.exit(1);
});