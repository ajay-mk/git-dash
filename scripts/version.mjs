#!/usr/bin/env node
// Keeps the app version in sync across every file that records it.
//
//   node scripts/version.mjs check [vX.Y.Z]   all files agree (and match the tag)
//   node scripts/version.mjs set X.Y.Z        bump all files together
//
// `npm version` is not used because .npmrc sets ignore-scripts, which also
// skips its lifecycle hooks, so it would only update package.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Plain X.Y.Z only: Windows MSI versions must be numeric, so pre-release
// suffixes such as -beta.1 would break the Windows build.
const SEMVER = /^\d+\.\d+\.\d+$/;

// Each entry locates the app's own version in one file. The patterns are
// anchored to the surrounding structure so dependency versions never match.
// Line breaks may be CRLF, as in a Windows checkout with core.autocrlf.
const FILES = [
  { path: 'package.json', pattern: /^( {2}"version": ")([^"]+)(")/m },
  { path: 'package-lock.json', pattern: /^( {2}"version": ")([^"]+)(")/m },
  {
    path: 'package-lock.json',
    pattern: /^( {4}"": \{\r?\n {6}"name": "gitdash",\r?\n {6}"version": ")([^"]+)(")/m,
  },
  { path: 'src-tauri/tauri.conf.json', pattern: /^( {2}"version": ")([^"]+)(")/m },
  // The first `version` key in Cargo.toml, which belongs to [package].
  { path: 'src-tauri/Cargo.toml', pattern: /^(\[package\]\r?\n(?:[^[\r\n].*\r?\n|\r?\n)*?version = ")([^"]+)(")/m },
  { path: 'src-tauri/Cargo.lock', pattern: /^(name = "gitdash"\r?\nversion = ")([^"]+)(")/m },
];

function read(file) {
  return readFileSync(join(root, file), 'utf8');
}

function versionIn(file, pattern) {
  const match = read(file).match(pattern);
  if (!match) throw new Error(`could not find the app version in ${file}`);
  return match[2];
}

function check(tag) {
  const found = FILES.map(({ path, pattern }) => ({ path, version: versionIn(path, pattern) }));
  const versions = new Set(found.map((f) => f.version));
  if (versions.size !== 1) {
    const list = found.map((f) => `  ${f.path}: ${f.version}`).join('\n');
    throw new Error(`versions disagree:\n${list}\nRun: npm run version:set -- X.Y.Z`);
  }
  const [version] = versions;
  if (!SEMVER.test(version)) throw new Error(`version ${version} is not X.Y.Z`);
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`tag ${tag} does not match the app version ${version} (expected v${version})`);
  }
  return version;
}

function set(version) {
  if (!SEMVER.test(version ?? '')) throw new Error('usage: version.mjs set X.Y.Z');
  // Fails fast if any file has lost its version field, before writing any.
  for (const { path, pattern } of FILES) versionIn(path, pattern);
  for (const { path, pattern } of FILES) {
    const updated = read(path).replace(pattern, `$1${version}$3`);
    writeFileSync(join(root, path), updated);
  }
  return check();
}

try {
  const [command, arg] = process.argv.slice(2);
  if (command === 'check') console.log(check(arg));
  else if (command === 'set') console.log(set(arg));
  else throw new Error('usage: version.mjs check [vX.Y.Z] | set X.Y.Z');
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
