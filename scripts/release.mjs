import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  VERSION_FILES,
  bumpWorkspaceVersion,
  getVersionSnapshot,
  resolveNextVersion,
} from "./bump-version.mjs";

const root = process.cwd();
const input = process.argv[2];
const shouldPush = process.argv.includes("--push");
const noteFlagIndex = process.argv.indexOf("--note");
const noteFlagValue = noteFlagIndex === -1 ? undefined : process.argv[noteFlagIndex + 1];

if (noteFlagIndex !== -1 && (!noteFlagValue || noteFlagValue.startsWith("--"))) {
  console.error('--note requires a value, for example: --note "Fixed account switching".');
  process.exit(1);
}

let releaseNote = noteFlagValue?.trim() ?? "";

if (!input) {
  console.error(
    'Usage: node scripts/release.mjs <version|major|minor|patch> [--push] [--note "short note"]',
  );
  process.exit(1);
}

if (!releaseNote) {
  if (!process.stdin.isTTY) {
    console.error('A release note is required. Pass it with --note "short note".');
    process.exit(1);
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  releaseNote = (await prompt.question("Short release note: ")).trim();
  prompt.close();

  if (!releaseNote) {
    console.error("Release note cannot be empty.");
    process.exit(1);
  }
}

const run = (command, args, options = {}) => {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
};

const capture = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
  }).trim();

const initialSnapshot = getVersionSnapshot(root);
const currentVersion = initialSnapshot["package.json"];
if (!currentVersion) {
  console.error("Could not determine current version from package.json");
  process.exit(1);
}

if (!resolveNextVersion(currentVersion, input)) {
  console.error(`Invalid version: ${input}`);
  process.exit(1);
}

const status = capture("git", ["status", "--short"]);
if (status) {
  console.error("Git working tree must be clean before running release.");
  console.error(status);
  process.exit(1);
}

const { nextVersion } = bumpWorkspaceVersion(input, root);
console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`);

const snapshot = getVersionSnapshot(root);
const mismatches = Object.entries(snapshot).filter(([, version]) => version !== nextVersion);
if (mismatches.length > 0) {
  console.error(`Version verification failed for ${nextVersion}:`);
  for (const [file, version] of mismatches) {
    console.error(`- ${file}: ${version ?? "missing"}`);
  }
  process.exit(1);
}

console.log(`Release version: ${nextVersion}`);
for (const file of VERSION_FILES) {
  console.log(`- ${file}: ${snapshot[file]}`);
}

run("git", ["add", ...VERSION_FILES]);
run("git", ["commit", "-m", `chore: release ${nextVersion}`]);
run("git", ["tag", "-a", `v${nextVersion}`, "-m", releaseNote]);

console.log(`Created commit and tag for v${nextVersion}.`);

const branch = capture("git", ["branch", "--show-current"]);
if (shouldPush) {
  run("git", ["push", "origin", branch]);
  run("git", ["push", "origin", `v${nextVersion}`]);
  console.log(`Pushed ${branch} and v${nextVersion}.`);
} else {
  console.log("Push skipped. Run these when ready:");
  console.log(`git push origin ${branch}`);
  console.log(`git push origin v${nextVersion}`);
}
