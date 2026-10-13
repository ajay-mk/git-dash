import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collect, installerOf, manifest, publishedName, signedVersion } from './updater.mjs';

/** A signature in the bundler's format, signed for `version`. */
function sig(file, version = '1.0.0') {
  const text = `untrusted comment: signature from tauri secret key\nRUQ=\ntrusted comment: timestamp:1\tfile:${file}\tversion:${version}\nZm9v\n`;
  return Buffer.from(text).toString('base64');
}

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'updater-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

describe('updater manifest', () => {
  it('knows every installer the bundler signs', () => {
    expect(installerOf('GitDash.app.tar.gz')).toBe('app');
    expect(installerOf('GitDash_1.0.0_x64_en-US.msi')).toBe('msi');
    expect(installerOf('GitDash_1.0.0_x64-setup.exe')).toBe('nsis');
    expect(installerOf('GitDash_1.0.0_amd64.AppImage')).toBe('appimage');
    expect(installerOf('GitDash_1.0.0_amd64.deb')).toBe('deb');
    expect(installerOf('GitDash-1.0.0-1.x86_64.rpm')).toBe('rpm');
    expect(() => installerOf('GitDash.dmg')).toThrow();
  });

  it('gives each macOS build its own archive name', () => {
    expect(publishedName('GitDash.app.tar.gz', 'aarch64-apple-darwin')).toBe('GitDash_aarch64.app.tar.gz');
    expect(publishedName('GitDash.app.tar.gz', 'x86_64-apple-darwin')).toBe('GitDash_x86_64.app.tar.gz');
    expect(publishedName('GitDash_1.0.0_amd64.deb', 'x86_64-unknown-linux-gnu')).toBe('GitDash_1.0.0_amd64.deb');
  });

  it('collects signed update files and skips unsigned ones', () => {
    const bundle = tempDir();
    const out = tempDir();
    const entries = join(tempDir(), 'entries');
    write(join(bundle, 'macos/GitDash.app.tar.gz'), 'archive');
    write(join(bundle, 'macos/GitDash.app.tar.gz.sig'), 'c2ln\n');
    write(join(bundle, 'macos/GitDash.app/Contents/Info.plist.sig'), 'not a release file');
    write(join(bundle, 'dmg/GitDash_1.0.0_aarch64.dmg'), 'disk image');
    expect(collect('aarch64-apple-darwin', bundle, out, entries)).toEqual({
      'darwin-aarch64-app': { file: 'GitDash_aarch64.app.tar.gz', signature: 'c2ln' },
    });
    expect(readdirSync(out)).toEqual(['GitDash_aarch64.app.tar.gz']);
    expect(JSON.parse(readFileSync(join(entries, 'aarch64-apple-darwin.json'), 'utf8'))).toHaveProperty('darwin-aarch64-app');
  });

  it('fails when nothing was signed', () => {
    const bundle = tempDir();
    write(join(bundle, 'deb/GitDash_1.0.0_amd64.deb'), 'package');
    expect(() => collect('x86_64-unknown-linux-gnu', bundle, tempDir(), tempDir())).toThrow(/no signed update files/);
  });

  const entries = {
    'darwin-aarch64-app': { file: 'GitDash_aarch64.app.tar.gz', signature: sig('GitDash.app.tar.gz') },
    'darwin-x86_64-app': { file: 'GitDash_x86_64.app.tar.gz', signature: sig('GitDash.app.tar.gz') },
    'windows-x86_64-msi': { file: 'GitDash_1.0.0_x64_en-US.msi', signature: sig('GitDash_1.0.0_x64_en-US.msi') },
    'windows-x86_64-nsis': { file: 'GitDash_1.0.0_x64-setup.exe', signature: sig('GitDash_1.0.0_x64-setup.exe') },
    'linux-x86_64-appimage': { file: 'GitDash_1.0.0_amd64.AppImage', signature: sig('GitDash_1.0.0_amd64.AppImage') },
  };
  const published = Object.values(entries).map((e) => e.file);

  it('points every platform at the release files, with a fallback per platform', () => {
    const latest = manifest({ repo: 'o/r', tag: 'v1.0.0', entries, published, date: new Date(0) });
    expect(latest.version).toBe('1.0.0');
    expect(latest.pub_date).toBe('1970-01-01T00:00:00.000Z');
    expect(latest.platforms['windows-x86_64-msi']).toEqual({
      url: 'https://github.com/o/r/releases/download/v1.0.0/GitDash_1.0.0_x64_en-US.msi',
      signature: entries['windows-x86_64-msi'].signature,
    });
    expect(latest.platforms['windows-x86_64']).toEqual(latest.platforms['windows-x86_64-nsis']);
    expect(latest.platforms['linux-x86_64']).toEqual(latest.platforms['linux-x86_64-appimage']);
    expect(latest.platforms['darwin-x86_64']).toEqual(latest.platforms['darwin-x86_64-app']);
  });

  it('reads the version a signature was made for', () => {
    expect(signedVersion(sig('a.deb', '2.3.4'))).toBe('2.3.4');
    expect(signedVersion(Buffer.from('untrusted comment: x\nRUQ=\ntrusted comment: timestamp:1\n').toString('base64'))).toBeNull();
  });

  it('refuses files signed for another version', () => {
    const stale = { ...entries, 'darwin-x86_64-app': { file: 'GitDash_x86_64.app.tar.gz', signature: sig('GitDash.app.tar.gz', '0.9.0') } };
    expect(() => manifest({ repo: 'o/r', tag: 'v1.0.0', entries: stale, published })).toThrow(/signed for version 0.9.0/);
  });

  it('refuses a manifest with a missing platform or file', () => {
    const noIntel = Object.fromEntries(Object.entries(entries).filter(([key]) => key !== 'darwin-x86_64-app'));
    expect(() => manifest({ repo: 'o/r', tag: 'v1.0.0', entries: noIntel, published })).toThrow(/darwin-x86_64/);
    expect(() => manifest({ repo: 'o/r', tag: 'v1.0.0', entries, published: published.slice(1) })).toThrow(/not among/);
  });
});
