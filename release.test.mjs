import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRelease, validatePackageFiles } from './scripts/release.mjs';

function fixture(t, version = '1.2.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rekall-release-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('rekall-release-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.codex-plugin'));
  fs.mkdirSync(path.join(root, 'skills', 'rekall'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@ditrixnew/rekall', version, files: ['bridge.mjs', 'assets/'] }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, 'skills', 'rekall', 'SKILL.md'), `---\nname: rekall\nmetadata:\n  version: "${version}"\n---\nInstructions.\n`);
  return root;
}

test('release accepts a matching tag and rejects an unrelated tag', t => {
  const root = fixture(t);
  assert.deepEqual(validateRelease(root, 'v1.2.3'), { version: '1.2.3', tag: 'v1.2.3' });
  assert.throws(() => validateRelease(root, 'v1.2.4'), /tag must match/);
});

test('release rejects version drift in independently installed components', t => {
  for (const file of ['package-lock.json', '.codex-plugin/plugin.json', 'skills/rekall/SKILL.md']) {
    const root = fixture(t);
    const target = path.join(root, file);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('1.2.3', '1.2.2'));
    assert.throws(() => validateRelease(root), /version differs/);
  }
});

test('release rejects unsafe or malformed versions and accepts a prerelease', t => {
  for (const version of ['../1.2.3', '01.2.3', '1.2.3-01', '1.2.3\nother']) {
    assert.throws(() => validateRelease(fixture(t, version)), /semver|leading zeroes/);
  }
  assert.equal(validateRelease(fixture(t, '1.2.3-rc.1')).tag, 'v1.2.3-rc.1');
});

test('package validation rejects untracked, private, or escaping files', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'bridge.mjs'), '// synthetic fixture\n');
  assert.doesNotThrow(() => validatePackageFiles(root, ['package.json', 'bridge.mjs'], new Set(['package.json', 'bridge.mjs'])));
  assert.throws(() => validatePackageFiles(root, ['bridge.mjs'], new Set()), /Untracked/);
  assert.throws(() => validatePackageFiles(root, ['../secret'], new Set()), /Unsafe/);
  assert.throws(() => validatePackageFiles(root, ['assets/.env'], new Set()), /Private/);
  assert.throws(() => validatePackageFiles(root, ['unexpected.txt'], new Set()), /allowlist/);
});
