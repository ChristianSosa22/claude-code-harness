#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MEASURE_KEYS = ['ncloc', 'complexity', 'cognitive_complexity'];
const PAGE_SIZE = 500;
const FILES_PER_REQUEST = 40;
const PREVIOUS_SHOWN = 20;
// A fixed path keeps a writable PATH entry from replacing git.
const GIT = '/usr/bin/git';
const CAFFEINATE = '/usr/bin/caffeinate';
const USAGE = 'Usage: sonar-group <project-key> --version <change>-g<N>   (example: sonar-group example-app --version audit-g2)';

function targetFile(header) {
  if (header === '+++ /dev/null') return null;
  const prefix = header.startsWith('+++ b/') ? '+++ b/' : '+++ ';
  return header.slice(prefix.length);
}

function addedRange(hunkHeader) {
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);
  if (!hunk) return null;
  const start = Number(hunk[1]);
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  return count === 0 ? null : { start, end: start + count - 1 };
}

export function parseAddedLines(unifiedZeroDiff) {
  const added = new Map();
  let file = null;
  for (const line of unifiedZeroDiff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = targetFile(line);
      continue;
    }
    const range = file === null ? null : addedRange(line);
    if (file !== null && range !== null) added.set(file, [...(added.get(file) ?? []), range]);
  }
  return added;
}

function overlaps(range, added) {
  return added.some((a) => range.startLine <= a.end && range.endLine >= a.start);
}

function issueLocations(issue) {
  const secondary = (issue.flows ?? [])
    .flatMap((f) => f.locations ?? [])
    .filter((l) => l.component === undefined || l.component === issue.component)
    .map((l) => l.textRange);
  return [issue.textRange, ...secondary].filter((r) => r !== undefined);
}

// An issue is new when one of its locations touches a line that the group adds. Cognitive complexity
// reports on the function name, and the increments that the group adds are only in the flows.
export function classifyIssues(issues, diff, projectKey) {
  const fresh = [];
  const previous = [];
  for (const issue of issues) {
    const file = issue.component.slice(projectKey.length + 1);
    const ranges = diff.added.get(file) ?? [];
    const isNew = diff.newFiles.has(file) || issueLocations(issue).some((r) => overlaps(r, ranges));
    (isNew ? fresh : previous).push(issue);
  }
  return { fresh, previous };
}

function issueLine(issue, projectKey) {
  const rule = issue.rule.replace(/^[a-z]+:/, '');
  const file = issue.component.slice(projectKey.length + 1);
  return `  ${rule} ${file}:${issue.line ?? 0} ${issue.message}`;
}

function measureLine(m) {
  const values = MEASURE_KEYS.map((k) => k + '=' + (m[k] ?? '-'));
  return `  ${m.file} ${values.join(' ')}`;
}

export function renderReport(projectKey, version, result, measures) {
  const hidden = result.previous.length - PREVIOUS_SHOWN;
  const lines = [
    `Sonar of the group: project=${projectKey} version=${version}`,
    `new=${result.fresh.length}`,
    ...result.fresh.map((i) => issueLine(i, projectKey)),
    `previous=${result.previous.length} (already in the files of the group; they do not block)`,
    ...result.previous.slice(0, PREVIOUS_SHOWN).map((i) => issueLine(i, projectKey)),
    ...(hidden > 0 ? [`  ... ${hidden} more`] : []),
    'measures:',
    ...measures.map(measureLine),
    result.fresh.length === 0 ? 'gate=PASS' : 'gate=FAIL',
  ];
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const [projectKey] = argv;
  const at = argv.indexOf('--version');
  const version = at >= 0 ? argv[at + 1] : undefined;
  if (!projectKey || projectKey.startsWith('--') || !/^[A-Za-z0-9][\w.:-]*$/.test(projectKey)) throw new Error(USAGE);
  if (!version || !/^[a-z0-9][a-z0-9-]*-g\d+$/.test(version)) throw new Error(USAGE);
  return { projectKey, version };
}

function withoutTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

// Each machine has its own folders, so nothing here names a personal path. The token default is the one
// scan.sh of the hub reads, so both read the same file unless SONAR_TOKEN_FILE moves it for both.
export function sonarSettings(env, home) {
  const hub = env.SONAR_HUB;
  if (!hub) throw new Error('SONAR_HUB is missing: the folder of the local SonarQube hub (the one that has scan.sh).');
  return {
    hub,
    hostUrl: withoutTrailingSlashes(env.SONAR_HOST_URL ?? 'http://127.0.0.1:9000'),
    tokenFile: env.SONAR_TOKEN_FILE ?? join(home, '.config', 'sonar-group', 'token'),
  };
}

// On battery, macOS sleeps after one minute without user input and the scan stops for the whole sleep: a bench run
// lost 403 s that way (power log, 2026-11-17). caffeinate -w holds off idle sleep until this process ends.
export function keepAwake(platform, pid, start = spawn) {
  if (platform !== 'darwin') return null;
  const child = start(CAFFEINATE, ['-i', '-w', String(pid)], { stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

function git(repo, ...args) {
  return execFileSync(GIT, ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function sonarGet(client, path, params) {
  const url = `${client.hostUrl}/api/${path}?${new URLSearchParams(params)}`;
  const authorization = 'Basic ' + Buffer.from(client.token + ':').toString('base64');
  return fetch(url, { headers: { Authorization: authorization } }).then((res) => (res.ok ? res.json() : null));
}

async function fetchIssueBatch(client, projectKey, files) {
  const page = (p) => sonarGet(client, 'issues/search', {
    componentKeys: projectKey, files, resolved: 'false', ps: String(PAGE_SIZE), p: String(p),
  });
  const first = await page(1);
  if (first === null) throw new Error('issues/search failed; check the analysis token and the project key');
  const more = Array.from({ length: Math.ceil(first.paging.total / PAGE_SIZE) - 1 }, (_, i) => page(i + 2));
  const rest = await Promise.all(more);
  return [first, ...rest].flatMap((p) => p?.issues ?? []);
}

async function fetchIssues(client, projectKey, files) {
  const batches = Array.from({ length: Math.ceil(files.length / FILES_PER_REQUEST) }, (_, i) =>
    files.slice(i * FILES_PER_REQUEST, (i + 1) * FILES_PER_REQUEST).join(','));
  return (await Promise.all(batches.map((b) => fetchIssueBatch(client, projectKey, b)))).flat();
}

async function fetchMeasures(client, projectKey, files) {
  const bodies = await Promise.all(files.map((file) => sonarGet(client, 'measures/component', {
    component: `${projectKey}:${file}`, metricKeys: MEASURE_KEYS.join(','),
  })));
  return files.flatMap((file, i) => {
    const body = bodies[i];
    if (!body) return [];
    const values = Object.fromEntries(body.component.measures.map((m) => [m.metric, m.value]));
    return [{ file, ...values }];
  });
}

async function main() {
  const { projectKey, version } = parseArgs(process.argv.slice(2));
  keepAwake(process.platform, process.pid);
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  // Values already in the environment win over .env.local.
  const localEnv = join(repo, '.env.local');
  if (existsSync(localEnv)) process.loadEnvFile(localEnv);
  const settings = sonarSettings(process.env, homedir());
  const scanScript = join(settings.hub, 'scan.sh');
  if (!existsSync(scanScript)) throw new Error(`${scanScript} does not exist. Check SONAR_HUB.`);

  const files = git(repo, 'diff', '--cached', '--name-only', '--diff-filter=d').split('\n').filter(Boolean);
  if (files.length === 0) {
    process.stderr.write('sonar-group sees no staged changes. Run git add -A first.\n');
    process.exit(2);
  }
  const diff = {
    added: parseAddedLines(git(repo, 'diff', '--cached', '-U0', '--no-color', '--no-ext-diff')),
    newFiles: new Set(git(repo, 'diff', '--cached', '--name-only', '--diff-filter=A').split('\n').filter(Boolean)),
  };

  // The scan and the read run in one command: scan.sh refuses a second scanner and a scan takes minutes,
  // so no other worktree's analysis can land between this analysis and the read below.
  const scan = spawnSync(scanScript, [projectKey, repo, version], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  const scanSummary = (scan.stdout ?? '').split('\n').filter((l) => /^(Analysis processed|ERROR)/.test(l));
  process.stdout.write(scanSummary.join('\n') + '\n');
  if (scan.status !== 0) {
    process.stderr.write(`scan.sh exited with ${scan.status}; the cause is in its output, above.\n`);
    process.exit(2);
  }

  const client = { hostUrl: settings.hostUrl, token: readFileSync(settings.tokenFile, 'utf8').trim() };
  const result = classifyIssues(await fetchIssues(client, projectKey, files), diff, projectKey);
  process.stdout.write(renderReport(projectKey, version, result, await fetchMeasures(client, projectKey, files)));
  process.exit(result.fresh.length === 0 ? 0 : 1);
}

// install.sh runs this file through a symlink; compare real paths so the link also starts main.
const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
}
