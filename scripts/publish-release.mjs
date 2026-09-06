import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function loadReleaseInput(manifestPath, env = process.env) {
  assert(env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF_TYPE === 'tag',
    'Release publication is allowed only for a GitHub tag-push event.');
  assert(REPOSITORY.test(env.GITHUB_REPOSITORY || ''), 'GITHUB_REPOSITORY must be owner/name.');
  assert(typeof manifestPath === 'string' && basename(manifestPath) === 'release.json',
    'The manifest path must name release.json.');
  const directory = dirname(resolve(manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const versionMatch = typeof manifest.version === 'string' && manifest.version.match(VERSION);
  assert(versionMatch && !versionMatch[4]?.split('.').some((part) => /^0\d+$/.test(part)),
    'Manifest version is invalid.');
  assert(manifest.tag === `v${manifest.version}`, 'Manifest tag must be v followed by version.');
  assert(env.GITHUB_REF_NAME === manifest.tag && env.GITHUB_REF === `refs/tags/${manifest.tag}`,
    'Workflow tag does not match the release manifest.');
  assert(COMMIT.test(manifest.sourceCommit || ''), 'Manifest sourceCommit must be a lowercase 40-character SHA.');
  assert(manifest.archiveName === `ditrixnew-rekall-${manifest.version}.tgz`,
    'Manifest archiveName must exactly match the package version.');
  assert(SHA256.test(manifest.sha256 || ''), 'Manifest sha256 is invalid.');

  const archivePath = resolve(directory, manifest.archiveName);
  const sumsPath = resolve(directory, 'SHA256SUMS.txt');
  const notesPath = resolve(directory, 'RELEASE_NOTES.md');
  for (const path of [archivePath, sumsPath, notesPath]) assert((await stat(path)).isFile(), `Missing release file: ${basename(path)}`);
  const [archive, sums, notes] = await Promise.all([
    readFile(archivePath), readFile(sumsPath), readFile(notesPath, 'utf8')
  ]);
  assert(digest(archive) === manifest.sha256, 'Archive SHA-256 does not match the manifest.');
  assert(sums.toString('utf8') === `${manifest.sha256}  ${manifest.archiveName}\n`,
    'SHA256SUMS.txt does not exactly match the archive.');
  assert(notes.trim().length > 0, 'RELEASE_NOTES.md must not be empty.');
  return { manifest, repository: env.GITHUB_REPOSITORY, archive, sums: Buffer.from(sums), notes };
}

async function resolveTagCommit(api, tag) {
  let object = await api.getTagReference(tag);
  for (let depth = 0; object.type === 'tag' && depth < 5; depth += 1) object = await api.getAnnotatedTag(object.sha);
  assert(object.type === 'commit' && COMMIT.test(object.sha || ''), 'Tag does not resolve to a commit.');
  return object.sha;
}

async function verifyAsset(api, asset, expected) {
  assert(asset, `Published release is missing asset ${expected.name}.`);
  const bytes = await api.downloadAsset(asset.id);
  assert(bytes.length === expected.bytes.length && digest(bytes) === digest(expected.bytes),
    `Release asset ${expected.name} does not match the local artifact.`);
}

export async function publishRelease({ manifestPath, env = process.env, api }) {
  const input = await loadReleaseInput(manifestPath, env);
  assert(api, 'A GitHub API client is required.');
  const commit = await resolveTagCommit(api, input.manifest.tag);
  assert(commit === input.manifest.sourceCommit, 'Release tag has moved from the packaged source commit.');
  const prerelease = input.manifest.version.includes('-');
  const expected = [
    { name: input.manifest.archiveName, bytes: input.archive, contentType: 'application/gzip' },
    { name: 'SHA256SUMS.txt', bytes: input.sums, contentType: 'text/plain; charset=utf-8' }
  ];
  let release = await api.getReleaseByTag(input.manifest.tag);
  if (!release) release = await api.createRelease({ tag: input.manifest.tag, commit, name: input.manifest.tag,
    body: input.notes, draft: true, prerelease });
  assert(release.target_commitish === commit, 'Existing release targets a different commit.');
  assert(Boolean(release.prerelease) === prerelease, 'Existing release prerelease status is inconsistent.');
  const assets = await api.listAssets(release.id);
  if (!release.draft) {
    for (const item of expected) await verifyAsset(api, assets.find((asset) => asset.name === item.name), item);
    return { status: 'already_published', release };
  }
  for (const item of expected) {
    const current = assets.find((asset) => asset.name === item.name);
    if (current) await verifyAsset(api, current, item);
    else await api.uploadAsset(release.upload_url, item);
  }
  const complete = await api.listAssets(release.id);
  for (const item of expected) await verifyAsset(api, complete.find((asset) => asset.name === item.name), item);
  const finalCommit = await resolveTagCommit(api, input.manifest.tag);
  assert(finalCommit === input.manifest.sourceCommit, 'Release tag moved while artifacts were uploaded.');
  release = await api.publishRelease(release.id, { draft: false, prerelease, make_latest: prerelease ? 'false' : 'true' });
  return { status: 'published', release };
}

export class GitHubRestApi {
  constructor({ token, repository, fetchImpl = globalThis.fetch }) {
    assert(token, 'GH_TOKEN is required.');
    assert(REPOSITORY.test(repository || ''), 'GitHub repository is invalid.');
    this.token = token; this.repository = repository; this.fetch = fetchImpl;
  }
  apiUrl(path) {
    const url = /^https:\/\//.test(path)
      ? new URL(path)
      : new URL(`https://api.github.com/repos/${this.repository}${path.startsWith('/') ? path : `/${path}`}`);
    assert(['https://api.github.com', 'https://uploads.github.com'].includes(url.origin) &&
      url.pathname.startsWith(`/repos/${this.repository}/`), 'Refusing to send credentials to an unexpected GitHub URL.');
    return url;
  }
  async request(path, options = {}) {
    const url = this.apiUrl(path);
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28', ...options.headers };
    if (typeof options.body === 'string' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await this.fetch(url, {
      ...options, headers, signal: options.signal || AbortSignal.timeout(30000)
    });
    if (response.status === 404 && options.allow404) return null;
    if (!response.ok) throw new Error(`GitHub API ${options.method || 'GET'} ${url.pathname} failed (${response.status}): ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }
  async getTagReference(tag) { return (await this.request(`/git/ref/tags/${encodeURIComponent(tag)}`)).object; }
  async getAnnotatedTag(sha) { return (await this.request(`/git/tags/${sha}`)).object; }
  getReleaseByTag(tag) { return this.request(`/releases/tags/${encodeURIComponent(tag)}`, { allow404: true }); }
  createRelease(value) { return this.request('/releases', { method: 'POST', body: JSON.stringify({ tag_name: value.tag,
    target_commitish: value.commit, name: value.name, body: value.body, draft: value.draft, prerelease: value.prerelease }) }); }
  listAssets(id) { return this.request(`/releases/${id}/assets?per_page=100`); }
  async uploadAsset(template, asset) {
    const url = `${template.replace(/\{.*$/, '')}?name=${encodeURIComponent(asset.name)}`;
    return this.request(url, { method: 'POST', headers: { 'Content-Type': asset.contentType, Accept: 'application/vnd.github+json' }, body: asset.bytes });
  }
  async downloadAsset(id) {
    const response = await this.fetch(this.apiUrl(`/releases/assets/${id}`), {
      headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'follow', signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Downloading GitHub release asset ${id} failed (${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  }
  publishRelease(id, value) { return this.request(`/releases/${id}`, { method: 'PATCH', body: JSON.stringify(value) }); }
}

async function main() {
  const manifestPath = process.argv[2];
  assert(manifestPath && process.argv.length === 3, 'Usage: node scripts/publish-release.mjs <path-to-release.json>');
  const api = new GitHubRestApi({ token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY });
  const result = await publishRelease({ manifestPath, api });
  process.stdout.write(`${result.status}: ${result.release.html_url || result.release.tag_name}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
