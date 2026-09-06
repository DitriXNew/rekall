import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubRestApi, publishRelease } from './scripts/publish-release.mjs';

const commit = 'a'.repeat(40);
async function fixture(t, version = '1.2.3') {
  const directory = await mkdtemp(join(tmpdir(), 'rekall-release-'));
  const resolved = resolve(directory);
  assert.equal(dirname(resolved), resolve(tmpdir()));
  assert.match(basename(resolved), /^rekall-release-/);
  t.after(() => rm(resolved, { recursive: true, force: true }));
  const archiveName = `ditrixnew-rekall-${version}.tgz`;
  const archive = Buffer.from('package bytes');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const manifest = { version, tag: `v${version}`, sourceCommit: commit, archiveName, sha256 };
  await Promise.all([
    writeFile(join(directory, archiveName), archive),
    writeFile(join(directory, 'SHA256SUMS.txt'), `${sha256}  ${archiveName}\n`),
    writeFile(join(directory, 'RELEASE_NOTES.md'), 'Release notes\n'),
    writeFile(join(directory, 'release.json'), JSON.stringify(manifest))
  ]);
  return { path: join(directory, 'release.json'), manifest };
}
function env(tag) { return { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag,
  GITHUB_REF: `refs/tags/${tag}`, GITHUB_REPOSITORY: 'owner/rekall' }; }

class FakeApi {
  constructor(release = null) { this.release = release; this.assets = []; this.bytes = new Map(); this.events = []; }
  async getTagReference() { return { type: 'commit', sha: commit }; }
  async getAnnotatedTag() { throw new Error('unexpected annotated tag'); }
  async getReleaseByTag() { return this.release; }
  async createRelease(value) { this.events.push('create-draft'); return this.release = { id: 1, body: value.body,
    draft: true, prerelease: value.prerelease, target_commitish: value.commit, upload_url: 'upload{?name}', tag_name: value.tag }; }
  async listAssets() { return this.assets; }
  async uploadAsset(_url, asset) { this.events.push(`upload:${asset.name}`); const stored = { id: this.assets.length + 1, name: asset.name };
    this.assets.push(stored); this.bytes.set(stored.id, Buffer.from(asset.bytes)); return stored; }
  async downloadAsset(id) { return this.bytes.get(id); }
  async publishRelease(_id, value) { this.events.push('publish'); return this.release = { ...this.release, ...value, draft: false }; }
}

test('creates a draft, uploads both verified assets, then publishes', async (t) => {
  const f = await fixture(t); const api = new FakeApi();
  const result = await publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api });
  assert.equal(result.status, 'published');
  assert.deepEqual(api.events, ['create-draft', `upload:${f.manifest.archiveName}`, 'upload:SHA256SUMS.txt', 'publish']);
  assert.equal(api.release.make_latest, 'true');
});

test('a matching published release is an idempotent no-op', async (t) => {
  const f = await fixture(t); const api = new FakeApi({ id: 1, body: 'Release notes\n', draft: false, prerelease: false,
    target_commitish: commit });
  await api.uploadAsset('', { name: f.manifest.archiveName, bytes: Buffer.from('package bytes') });
  await api.uploadAsset('', { name: 'SHA256SUMS.txt', bytes: Buffer.from(`${f.manifest.sha256}  ${f.manifest.archiveName}\n`) });
  api.events = [];
  assert.equal((await publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api })).status, 'already_published');
  assert.deepEqual(api.events, []);
});

test('resumes a matching draft by uploading only the missing asset and preserves its notes', async (t) => {
  const f = await fixture(t);
  const api = new FakeApi({ id: 1, body: 'Notes from the original workflow run\n', draft: true, prerelease: false,
    target_commitish: commit, upload_url: 'upload{?name}' });
  await api.uploadAsset('', { name: f.manifest.archiveName, bytes: Buffer.from('package bytes') });
  api.events = [];
  await publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api });
  assert.deepEqual(api.events, ['upload:SHA256SUMS.txt', 'publish']);
  assert.equal(api.release.body, 'Notes from the original workflow run\n');
});

test('refuses to alter a draft containing a mismatched asset', async (t) => {
  const f = await fixture(t);
  const api = new FakeApi({ id: 1, body: 'Release notes\n', draft: true, prerelease: false,
    target_commitish: commit, upload_url: 'upload{?name}' });
  await api.uploadAsset('', { name: f.manifest.archiveName, bytes: Buffer.from('wrong') });
  api.events = [];
  await assert.rejects(publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api }), /does not match/);
  assert.deepEqual(api.events, []);
  assert.equal(api.release.draft, true);
});

test('refuses a published release with a missing or mismatched asset', async (t) => {
  const f = await fixture(t); const release = { id: 1, draft: false, prerelease: false, target_commitish: commit };
  const missing = new FakeApi(release);
  await assert.rejects(publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api: missing }), /missing asset/);
  const wrong = new FakeApi(release);
  await wrong.uploadAsset('', { name: f.manifest.archiveName, bytes: Buffer.from('wrong') });
  await wrong.uploadAsset('', { name: 'SHA256SUMS.txt', bytes: Buffer.from(`${f.manifest.sha256}  ${f.manifest.archiveName}\n`) });
  await assert.rejects(publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api: wrong }), /does not match/);
});

test('a failed upload leaves the release as a draft', async (t) => {
  const f = await fixture(t); const api = new FakeApi();
  api.uploadAsset = async () => { api.events.push('upload-failed'); throw new Error('upload failed'); };
  await assert.rejects(publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api }), /upload failed/);
  assert.equal(api.release.draft, true); assert.deepEqual(api.events, ['create-draft', 'upload-failed']);
});

test('rejects tag drift before creating a release', async (t) => {
  const f = await fixture(t); const api = new FakeApi();
  api.getTagReference = async () => ({ type: 'commit', sha: 'b'.repeat(40) });
  await assert.rejects(publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api }), /tag has moved/);
  assert.equal(api.release, null);
});

test('does not publish when the tag moves during asset uploads', async (t) => {
  const f = await fixture(t); const api = new FakeApi(); let checks = 0;
  api.getTagReference = async () => ({ type: 'commit', sha: ++checks === 1 ? commit : 'b'.repeat(40) });
  await assert.rejects(publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api }), /moved while artifacts/);
  assert.deepEqual(api.events, ['create-draft', `upload:${f.manifest.archiveName}`, 'upload:SHA256SUMS.txt']);
  assert.equal(api.release.draft, true);
});

test('rejects numeric prerelease identifiers with leading zeroes', async (t) => {
  const f = await fixture(t, '1.2.3-rc.01');
  await assert.rejects(publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api: new FakeApi() }),
    /version is invalid/);
});

test('prerelease versions are published as prereleases and not latest', async (t) => {
  const f = await fixture(t, '1.2.3-rc.1+build.5'); const api = new FakeApi();
  await publishRelease({ manifestPath: f.path, env: env(f.manifest.tag), api });
  assert.equal(api.release.prerelease, true); assert.equal(api.release.make_latest, 'false');
});

test('REST writes use JSON headers and credentials stay on repository GitHub URLs', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ id: 1 }), text: async () => '' };
  };
  const api = new GitHubRestApi({ token: 'secret', repository: 'owner/rekall', fetchImpl });
  await api.createRelease({ tag: 'v1.2.3', commit, name: 'v1.2.3', body: 'notes', draft: true, prerelease: false });
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/rekall/releases');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  await assert.rejects(api.request('https://example.com/repos/owner/rekall/releases'), /Refusing to send credentials/);
  assert.equal(calls.length, 1);
});
