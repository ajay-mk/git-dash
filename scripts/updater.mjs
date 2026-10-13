#!/usr/bin/env node
// Builds the update manifest (latest.json) the in-app updater reads.
//
//   node scripts/updater.mjs collect <target> <bundle-dir> <out-dir> <entries-dir>
//       After a build: copies each signed update file into <out-dir> under
//       the name it is published as, and records its signature in
//       <entries-dir>/<target>.json.
//   node scripts/updater.mjs manifest <owner/repo> <tag> <entries-dir> <out-dir>
//       Once every build is in: writes <out-dir>/latest.json.
//
// The bundler signs each update file with the key in TAURI_SIGNING_PRIVATE_KEY
// and writes the signature next to it as <file>.sig.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The updater looks up `{os}-{arch}-{installer}` first, then `{os}-{arch}`.
const PLATFORMS = {
  'aarch64-apple-darwin': 'darwin-aarch64',
  'x86_64-apple-darwin': 'darwin-x86_64',
  'x86_64-pc-windows-msvc': 'windows-x86_64',
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
};

// What an app installed some other way (or from an older build that does not
// know its installer) updates from.
const FALLBACK = { darwin: 'app', windows: 'nsis', linux: 'appimage' };

const INSTALLERS = [
  ['.app.tar.gz', 'app'],
  ['.msi', 'msi'],
  ['.exe', 'nsis'],
  ['.AppImage', 'appimage'],
  ['.deb', 'deb'],
  ['.rpm', 'rpm'],
];

export function installerOf(file) {
  const match = INSTALLERS.find(([suffix]) => file.endsWith(suffix));
  if (!match) throw new Error(`unknown update file ${file}`);
  return match[1];
}

/** The name a file is published under. Both macOS builds name theirs GitDash.app.tar.gz. */
export function publishedName(file, target) {
  if (!file.endsWith('.app.tar.gz')) return file;
  return `${file.slice(0, -'.app.tar.gz'.length)}_${target.split('-')[0]}.app.tar.gz`;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // A macOS .app is a directory; nothing inside it is signed separately.
    if (entry.isDirectory()) {
      if (!entry.name.endsWith('.app')) yield* walk(path);
    } else yield path;
  }
}

export function collect(target, bundleDir, outDir, entriesDir) {
  const platform = PLATFORMS[target];
  if (!platform) throw new Error(`unknown target ${target}`);
  const entries = {};
  for (const sig of walk(bundleDir)) {
    if (!sig.endsWith('.sig')) continue;
    const file = sig.slice(0, -'.sig'.length);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const key = `${platform}-${installerOf(basename(file))}`;
    if (entries[key]) throw new Error(`two update files for ${key}: ${entries[key].file} and ${basename(file)}`);
    const name = publishedName(basename(file), target);
    copyFileSync(file, join(outDir, name));
    entries[key] = { file: name, signature: readFileSync(sig, 'utf8').trim() };
  }
  if (Object.keys(entries).length === 0) throw new Error(`no signed update files under ${bundleDir}`);
  mkdirSync(entriesDir, { recursive: true });
  writeFileSync(join(entriesDir, `${target}.json`), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

/** The version a signature was made for, from its trusted comment (null if it has none). */
export function signedVersion(signature) {
  const text = Buffer.from(signature, 'base64').toString('utf8');
  const comment = text.split('\n').find((line) => line.startsWith('trusted comment: '));
  const field = comment?.slice('trusted comment: '.length).split('\t').find((f) => f.startsWith('version:'));
  return field ? field.slice('version:'.length) : null;
}

export function manifest({ repo, tag, entries, published, date = new Date() }) {
  const version = tag.replace(/^v/, '');
  const platforms = {};
  for (const [key, { file, signature }] of Object.entries(entries)) {
    if (!published.includes(file)) throw new Error(`${file} (for ${key}) is not among the release files`);
    // The app is set to refuse an update signed for another version.
    if (signedVersion(signature) !== version) {
      throw new Error(`${file} was signed for version ${signedVersion(signature)}, not ${version}`);
    }
    platforms[key] = {
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
      signature,
    };
  }
  for (const platform of Object.values(PLATFORMS)) {
    const fallback = platforms[`${platform}-${FALLBACK[platform.split('-')[0]]}`];
    if (!fallback) throw new Error(`no update for ${platform}`);
    platforms[platform] = fallback;
  }
  return {
    version,
    notes: `See https://github.com/${repo}/releases/tag/${tag}`,
    pub_date: date.toISOString(),
    platforms,
  };
}

function readEntries(entriesDir) {
  const entries = {};
  for (const name of readdirSync(entriesDir).filter((n) => n.endsWith('.json'))) {
    for (const [key, entry] of Object.entries(JSON.parse(readFileSync(join(entriesDir, name), 'utf8')))) {
      if (entries[key]) throw new Error(`two update files for ${key}`);
      entries[key] = entry;
    }
  }
  return entries;
}

function main([command, ...args]) {
  if (command === 'collect' && args.length === 4) {
    const entries = collect(...args);
    for (const [key, { file }] of Object.entries(entries)) console.log(`${key}: ${file}`);
  } else if (command === 'manifest' && args.length === 4) {
    const [repo, tag, entriesDir, outDir] = args;
    const latest = manifest({ repo, tag, entries: readEntries(entriesDir), published: readdirSync(outDir) });
    writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
    console.log(Object.keys(latest.platforms).join('\n'));
  } else {
    throw new Error(
      'usage: updater.mjs collect <target> <bundle-dir> <out-dir> <entries-dir>\n' +
        '       updater.mjs manifest <owner/repo> <tag> <entries-dir> <out-dir>',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
