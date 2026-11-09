import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION_FILES = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

const PACKAGE_VERSION_RE = /"version"\s*:\s*"(\d+\.\d+\.\d+)"/;
const CARGO_VERSION_RE = /^version\s*=\s*"(\d+\.\d+\.\d+)"/m;
const CARGO_LOCK_BLOCK_RE =
  /(\[\[package\]\]\nname = "codex-switcher"\nversion = ")(\d+\.\d+\.\d+)("[\s\S]*?\n\n)/;

export const parseVersion = (version) => {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};

export const bumpVersion = (version, bumpType) => {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  if (bumpType === "major") return `${parsed.major + 1}.0.0`;
  if (bumpType === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  if (bumpType === "patch") return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  return null;
};

export const resolveNextVersion = (currentVersion, input) => {
  const candidate = ["major", "minor", "patch"].includes(input)
    ? bumpVersion(currentVersion, input)
    : input;
  return candidate && parseVersion(candidate) ? candidate : null;
};

export const parsePackageVersion = (contents) =>
  contents.match(PACKAGE_VERSION_RE)?.[1] ?? null;

export const getVersionSnapshot = (root = process.cwd()) => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  return {
    "package.json": parsePackageVersion(read("package.json")),
    "src-tauri/tauri.conf.json": parsePackageVersion(read("src-tauri/tauri.conf.json")),
    "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(CARGO_VERSION_RE)?.[1] ?? null,
    "src-tauri/Cargo.lock": read("src-tauri/Cargo.lock").match(CARGO_LOCK_BLOCK_RE)?.[2] ?? null,
  };
};

export const bumpWorkspaceVersion = (input, root = process.cwd()) => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const write = (rel, contents) => fs.writeFileSync(path.join(root, rel), contents, "utf8");

  const packageJson = read("package.json");
  const currentVersion = parsePackageVersion(packageJson);
  if (!currentVersion) {
    throw new Error("Could not find version in package.json");
  }

  const nextVersion = resolveNextVersion(currentVersion, input);
  if (!nextVersion) {
    throw new Error(`Invalid version: ${input}`);
  }

  const cargoLock = read("src-tauri/Cargo.lock");
  if (!CARGO_LOCK_BLOCK_RE.test(cargoLock)) {
    throw new Error("Could not find codex-switcher package in Cargo.lock");
  }

  const replaceJsonVersion = (contents) =>
    contents.replace(PACKAGE_VERSION_RE, `"version": "${nextVersion}"`);

  write("package.json", replaceJsonVersion(packageJson));
  write("src-tauri/tauri.conf.json", replaceJsonVersion(read("src-tauri/tauri.conf.json")));
  write(
    "src-tauri/Cargo.toml",
    read("src-tauri/Cargo.toml").replace(CARGO_VERSION_RE, `version = "${nextVersion}"`),
  );
  write("src-tauri/Cargo.lock", cargoLock.replace(CARGO_LOCK_BLOCK_RE, `$1${nextVersion}$3`));

  return { currentVersion, nextVersion };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node scripts/bump-version.mjs <version|major|minor|patch>");
    process.exit(1);
  }
  try {
    const { currentVersion, nextVersion } = bumpWorkspaceVersion(input);
    console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
