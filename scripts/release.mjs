#!/usr/bin/env node
// Release the watchface: CHANGELOG.md from the conventional commits since the
// last tag, version bump, store build, commit, tag, push, GitHub release with
// the .pbw and the built settings site (dist/, zipped). The live site is not
// deployed: that stays `npm run deploy`. Your own words for the release go in
// RELEASE_NOTES.md (not in git); they go above the generated list and the file
// is removed once the release is out. Run from a clean main:
//   npm run release                 # bump from the commits (feat → minor, fix/perf → patch, ! → major)
//   npm run release -- minor        # or force major | minor | patch | 1.2.0
//   npm run release -- --dry-run    # show the version and notes, change nothing
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'https://github.com/jesse-mm/nightwatch';
const PACKAGE = 'watchface/package.json';
const PBW = 'watchface/build/watchface.pbw';
const SITE = 'dist';
const OWN_NOTES = 'RELEASE_NOTES.md';
// Sections in the changelog; other types (docs, chore, ...) are left out.
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forced = args.find((a) => !a.startsWith('--'));

const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...opts }).trim();
const git = (...a) => run('git', a);
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

// ------------------------------------------------------------------ checks

if (git('branch', '--show-current') !== 'main') fail('not on main');
if (!dryRun && git('status', '--porcelain')) fail('the working tree has uncommitted changes');
const lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*');

// ----------------------------------------------------------------- commits

const COMMIT = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
const commits = git('log', '--format=%H%x1f%s%x1f%b%x1e', `${lastTag}..HEAD`)
  .split('\x1e')
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [hash, subject, body] = c.split('\x1f');
    const m = COMMIT.exec(subject);
    return m && {
      hash,
      type: m[1],
      scope: m[2],
      breaking: Boolean(m[3]) || /^BREAKING[ -]CHANGE:/m.test(body),
      description: m[4],
    };
  })
  .filter(Boolean);

// ----------------------------------------------------------------- version

const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const bump = forced ||
  (commits.some((c) => c.breaking) ? 'major'
    : commits.some((c) => c.type === 'feat') ? 'minor'
      : commits.some((c) => c.type === 'fix' || c.type === 'perf') ? 'patch'
        : null);
if (!bump) fail(`no feat, fix or perf commits since ${lastTag}; pass a bump to release anyway`);
const version = bump === 'major' ? `${major + 1}.0.0`
  : bump === 'minor' ? `${major}.${minor + 1}.0`
    : bump === 'patch' ? `${major}.${minor}.${patch + 1}`
      : bump;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`not a version or bump: ${bump}`);
const tag = `v${version}`;
if (git('tag', '--list', tag)) fail(`${tag} already exists`);

// --------------------------------------------------------------- changelog

const line = (c) => {
  const scope = c.scope ? `**${c.scope}:** ` : '';
  return `- ${scope}${c.description} ([${c.hash.slice(0, 7)}](${REPO}/commit/${c.hash}))`;
};
const generated = [
  ['Breaking changes', commits.filter((c) => c.breaking)],
  ...SECTIONS.map(([type, title]) => [title, commits.filter((c) => c.type === type && !c.breaking)]),
]
  .filter(([, items]) => items.length)
  .map(([title, items]) => `### ${title}\n\n${items.map(line).join('\n')}\n`)
  .join('\n');
const own = existsSync(OWN_NOTES) ? readFileSync(OWN_NOTES, 'utf8').trim() : '';
const notes = [own && `${own}\n`, generated].filter(Boolean).join('\n') || 'Maintenance only.\n';
const date = new Date().toISOString().slice(0, 10);
const section = `## [${version}](${REPO}/compare/${lastTag}...${tag}) (${date})\n\n${notes}`;

// The live settings page should match the new watchface: remind to deploy it.
const siteChanged = git('diff', '--name-only', lastTag, 'HEAD', '--', 'site') !== '';
const deployHint = siteChanged ? `site/ changed since ${lastTag}: deploy it with \`npm run deploy\`` : '';

console.log(`${pkg.version} → ${version} (${commits.length} commits since ${lastTag})\n\n${section}`);
if (dryRun) {
  if (deployHint) console.log(deployHint);
  process.exit(0);
}

// The push and the release need GitHub access; find out before changing anything.
try {
  run('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'pipe' });
  run('git', ['push', '--dry-run', 'origin', 'main'], { stdio: 'pipe' });
} catch (e) {
  fail(`can't reach GitHub (${e.stderr?.trim() || e.message}); try \`gh auth login\` and \`gh auth setup-git\``);
}

// ----------------------------------------------------------------- release

// The settings site with its catalog (catalog/web must be there), built first:
// it doesn't depend on the version, so a failure here changes nothing.
execFileSync('npm', ['run', 'build:site'], { stdio: 'inherit' });

const HEADER = '# Changelog\n\nWhat changed in each NightWatch release. Generated by `npm run release`.\n\n';
const old = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8').replace(HEADER, '') : '';
writeFileSync('CHANGELOG.md', `${HEADER}${section}\n${old}`.trimEnd() + '\n');
writeFileSync(PACKAGE, readFileSync(PACKAGE, 'utf8').replace(`"version": "${pkg.version}"`, `"version": "${version}"`));

// The store build: always config.production.js, never a local config.dev.js.
execFileSync('npm', ['run', 'build:watch'], { stdio: 'inherit' });
const built = JSON.parse(run('unzip', ['-p', PBW, 'appinfo.json']));
if (built.versionLabel !== version) fail(`the build says ${built.versionLabel}, expected ${version}`);

git('add', 'CHANGELOG.md', PACKAGE);
git('commit', '-m', `chore(release): ${version}`);
git('tag', '-a', tag, '-m', `NightWatch ${version}`);
execFileSync('git', ['push', '--follow-tags', 'origin', 'main'], { stdio: 'inherit' });

const assets = mkdtempSync(join(tmpdir(), 'nightwatch-'));
const pbw = join(assets, `nightwatch-${version}.pbw`);
const site = join(assets, `nightwatch-site-${version}.zip`);
copyFileSync(PBW, pbw);
run('zip', ['-qrX', site, '.'], { cwd: SITE });
execFileSync('gh', ['release', 'create', tag, pbw, site, '--title', `NightWatch ${version}`, '--notes', notes],
  { stdio: 'inherit' });
// Used up: they're in CHANGELOG.md and on the release now.
rmSync(OWN_NOTES, { force: true });
if (deployHint) console.log(`\n${deployHint}`);
