import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function validateRelease(root, requestedTag) {
  const pkg = json(path.join(root, 'package.json'));
  assert.equal(pkg.name, '@ditrixnew/rekall', 'Unexpected package name');
  const version = pkg.version;
  const match = typeof version === 'string' && version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/);
  assert.ok(match, 'Package version must be valid semver');
  assert.ok(!match[4]?.split('.').some(part => /^0\d+$/.test(part)), 'Numeric prerelease identifiers must not have leading zeroes');
  const tag = `v${version}`;
  if (requestedTag !== undefined) assert.equal(requestedTag, tag, 'Release tag must match package version');
  const lock = json(path.join(root, 'package-lock.json'));
  const plugin = json(path.join(root, '.codex-plugin', 'plugin.json'));
  const skill = fs.readFileSync(path.join(root, 'skills', 'rekall', 'SKILL.md'), 'utf8');
  const frontmatter = skill.split('---', 3)[1];
  const skillVersion = frontmatter?.match(/^  version: ["']?([^"'\r\n]+)["']?\s*$/m)?.[1];
  for (const [label, actual] of Object.entries({ lockfile: lock.version, lockfileRoot: lock.packages?.['']?.version, plugin: plugin.version, skill: skillVersion })) {
    assert.equal(actual, version, `${label} version differs from package.json`);
  }
  return { version, tag };
}

export function validatePackageFiles(root, files, trackedFiles) {
  const pkg = json(path.join(root, 'package.json'));
  const allowlist = [...pkg.files, 'package.json'];
  assert.ok(files.length > 0, 'Package must not be empty');
  assert.equal(new Set(files).size, files.length, 'Duplicate package paths');
  for (const file of files) {
    assert.ok(typeof file === 'string' && !path.posix.isAbsolute(file) && !file.includes('\\') && !file.split('/').includes('..'), 'Unsafe package path');
    assert.ok(!/(^|\/)(?:\.git|node_modules|jobs|\.env(?:\.[^/]*)?)(\/|$)|\.handoff\.json$|\.(?:tgz|log)$/.test(file), `Private or generated package path: ${file}`);
    assert.ok(allowlist.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry), `File is outside package allowlist: ${file}`);
    assert.ok(trackedFiles.has(file), `Untracked file in package: ${file}`);
    assert.ok(fs.lstatSync(path.join(root, file)).isFile(), `Package path is not a regular file: ${file}`);
  }
}

export async function smokeMcp(bridge, version) {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, 'mcp'], { cwd: path.dirname(bridge), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged MCP initialization timed out')); }, 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]]) {
      stream.setEncoding('utf8');
      stream.on('data', value => {
        append(value);
        if (stdout.length + stderr.length > 1024 * 1024) { child.kill(); reject(new Error('Excessive MCP output')); }
      });
    }
    child.on('close', code => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, `MCP exited unsuccessfully: ${stderr}`);
        assert.equal(stderr, '', 'MCP wrote unexpected diagnostics');
        const responses = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
        assert.deepEqual(responses.find(item => item.id === 1)?.result?.serverInfo, { name: 'rekall', version });
        const names = responses.find(item => item.id === 2)?.result?.tools?.map(tool => tool.name).sort();
        assert.deepEqual(names, ['cancel_compaction', 'compaction_status', 'probe_compaction', 'schedule_compaction']);
        resolve();
      } catch (error) { reject(error); }
    });
    child.stdin.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-verification', version: '1.0.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map(item => JSON.stringify(item)).join('\n') + '\n');
  });
}

export async function buildRelease(root, outputDirectory, requestedTag) {
  const { version, tag } = validateRelease(root, requestedTag);
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(dirty, '', 'Commit tracked changes before building source-bound release artifacts');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(sourceCommit, /^[0-9a-f]{40}$/);
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli && path.isAbsolute(npmCli) && fs.existsSync(npmCli), 'Build through npm run release:build so the npm CLI is explicit');
  const npm = async args => execute(process.execPath, [npmCli, ...args], { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const destination = path.resolve(outputDirectory);
  fs.mkdirSync(destination, { recursive: true });
  const { stdout } = await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', destination]);
  const packed = JSON.parse(stdout);
  assert.equal(packed.length, 1, 'Expected one npm archive');
  const record = packed[0];
  assert.equal(record.name, '@ditrixnew/rekall');
  assert.equal(record.version, version);
  assert.equal(record.filename, `ditrixnew-rekall-${version}.tgz`);
  const files = record.files.map(file => file.path);
  const trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
  validatePackageFiles(root, files, trackedFiles);
  const archive = path.join(destination, record.filename);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rekall-release-install-'));
  try {
    await npm(['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', archive]);
    const installed = path.join(temporary, 'node_modules', '@ditrixnew', 'rekall');
    for (const file of files) {
      assert.ok(fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(path.join(installed, file))), `Packaged content differs: ${file}`);
    }
    await smokeMcp(path.join(installed, 'bridge.mjs'), version);
  } finally {
    if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('rekall-release-install-')) {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const manifest = { version, tag, sourceCommit, archiveName: record.filename, sha256 };
  fs.writeFileSync(path.join(destination, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), `${sha256}  ${record.filename}\n`);
  const run = process.env.GITHUB_RUN_ID;
  const evidence = run ? `https://github.com/DitriXNew/rekall/actions/runs/${run}` : 'Local build; see GitHub Actions for release checks.';
  fs.writeFileSync(path.join(destination, 'RELEASE_NOTES.md'), `Rekall ${version} compacts context within one Codex VS Code extension thread, preserves a verified handoff, and can continue authorized work once.\n\n` +
    `## Install\n\nRequires Node.js 20 or newer and the Codex extension in VS Code on Windows, macOS, or Linux.\n\n` +
    '```text\n' + `codex plugin marketplace add DitriXNew/rekall --ref ${tag}\ncodex plugin add rekall@rekall\n` + '```\n\n' +
    `Start a new VS Code extension chat after installation. Standalone Codex CLI sessions, the Codex desktop app, and Claude Code are unsupported because this adapter requires the extension's IPC owner and lifecycle.\n\n` +
    `The attached npm archive is available for manual installation. Check its SHA-256 using SHA256SUMS.txt.\n\n` +
    `## Verification\n\nSource commit: ${sourceCommit}.\n\nThe release workflow requires the Windows/macOS/Linux test matrix and HOL scanner gate to pass. The exact archive was installed in a temporary directory and its MCP version and tools were checked. Evidence: ${evidence}\n\n` +
    `See README.md, SECURITY.md, and live-verification.json in the source repository for scope, historical measurements, and verification limits.\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, argument] = process.argv.slice(2);
    let result;
    if (command === 'validate') result = validateRelease(process.cwd(), argument);
    else if (command === 'build') result = await buildRelease(process.cwd(), argument ?? 'dist', process.env.REKALL_RELEASE_TAG);
    else throw new Error('Usage: release.mjs validate [tag] | build [output-directory]');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\n`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
