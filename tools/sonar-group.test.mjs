import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyIssues, keepAwake, parseAddedLines, parseArgs, renderReport, sonarSettings } from './sonar-group.mjs';

const KEY = 'demo-project';

const diffText = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,0 +11,3 @@ function load() {',
  '+  const x = 1;',
  '+  const y = 2;',
  '+  return x + y;',
  '@@ -40 +43 @@',
  '-old',
  '+new',
  '@@ -60,2 +63,0 @@',
  '-gone',
  '-gone too',
  'diff --git a/src/removed.ts b/src/removed.ts',
  '--- a/src/removed.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
  'diff --git a/src/b.ts b/src/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/b.ts',
  '@@ -0,0 +1,2 @@',
  '+export const b = 1;',
  '+export const c = 2;',
].join('\n');

const issue = (component, startLine, over = {}) => ({
  rule: 'typescript:S1234',
  component: `${KEY}:${component}`,
  message: 'invented message',
  ...(startLine === undefined ? {} : { line: startLine, textRange: { startLine, endLine: startLine } }),
  ...over,
});

describe('parseAddedLines', () => {
  it('takes the added line ranges of each hunk and skips deletions and removed files', () => {
    const added = parseAddedLines(diffText);
    assert.deepEqual(added.get('src/a.ts'), [{ start: 11, end: 13 }, { start: 43, end: 43 }]);
    assert.deepEqual(added.get('src/b.ts'), [{ start: 1, end: 2 }]);
    assert.equal(added.has('src/removed.ts'), false);
  });
});

describe('classifyIssues', () => {
  const diff = { added: parseAddedLines(diffText), newFiles: new Set(['src/b.ts']) };

  it('marks an issue on an added line as new and an issue on an old line as previous', () => {
    const { fresh, previous } = classifyIssues([issue('src/a.ts', 12), issue('src/a.ts', 30)], diff, KEY);
    assert.deepEqual(fresh.map((i) => i.line), [12]);
    assert.deepEqual(previous.map((i) => i.line), [30]);
  });

  it('marks the cognitive complexity of an old function as new when the group adds an increment', () => {
    const complexity = issue('src/a.ts', 5, {
      rule: 'typescript:S3776',
      flows: [{ locations: [{ component: `${KEY}:src/a.ts`, textRange: { startLine: 43, endLine: 43 } }] }],
    });
    assert.deepEqual(classifyIssues([complexity], diff, KEY).fresh, [complexity]);
  });

  it('ignores a secondary location in another file', () => {
    const other = issue('src/a.ts', 5, {
      flows: [{ locations: [{ component: `${KEY}:src/c.ts`, textRange: { startLine: 12, endLine: 12 } }] }],
    });
    assert.deepEqual(classifyIssues([other], diff, KEY).previous, [other]);
  });

  it('marks a whole-file issue as new only when the file is new in the group', () => {
    const { fresh, previous } = classifyIssues([issue('src/b.ts', undefined), issue('src/a.ts', undefined)], diff, KEY);
    assert.deepEqual(fresh.map((i) => i.component), [`${KEY}:src/b.ts`]);
    assert.deepEqual(previous.map((i) => i.component), [`${KEY}:src/a.ts`]);
  });
});

describe('renderReport', () => {
  it('lists the new issues, counts the previous ones, shows the measures and gives the verdict', () => {
    const report = renderReport(KEY, 'audit-g1', { fresh: [issue('src/a.ts', 12)], previous: [issue('src/a.ts', 30)] }, [
      { file: 'src/a.ts', ncloc: '120', complexity: '14', cognitive_complexity: '9' },
    ]);
    assert.match(report, /project=demo-project version=audit-g1/);
    assert.match(report, /new=1\n {2}S1234 src\/a\.ts:12 invented message/);
    assert.match(report, /previous=1/);
    assert.match(report, /src\/a\.ts ncloc=120 complexity=14 cognitive_complexity=9/);
    assert.match(report, /gate=FAIL\n$/);
  });

  it('gives PASS when the group adds no issue', () => {
    assert.match(renderReport(KEY, 'audit-g1', { fresh: [], previous: [] }, []), /gate=PASS\n$/);
  });
});

describe('parseArgs', () => {
  it('accepts a project key and a version with the change name and the group number', () => {
    assert.deepEqual(parseArgs(['example-app', '--version', 'audit-sonar-g2']), { projectKey: 'example-app', version: 'audit-sonar-g2' });
  });

  it('rejects a missing project key or a version without a group number', () => {
    assert.throws(() => parseArgs(['--version', 'audit-g2']), /Usage: sonar-group <project-key>/);
    assert.throws(() => parseArgs(['example-app', '--version', 'audit']), /<change>-g<N>/);
    assert.throws(() => parseArgs([]), /Usage/);
  });
});

describe('sonarSettings', () => {
  it('requires SONAR_HUB because each machine has its own folder', () => {
    assert.throws(() => sonarSettings({}, '/home/invented'), /SONAR_HUB is missing/);
  });

  it('uses the local server and the hub token when only SONAR_HUB is set', () => {
    assert.deepEqual(sonarSettings({ SONAR_HUB: '/opt/sonar-hub' }, '/home/invented'), {
      hub: '/opt/sonar-hub',
      hostUrl: 'http://127.0.0.1:9000',
      tokenFile: '/home/invented/.config/sonar-group/token',
    });
  });

  it('takes the URL and the token file that the person sets', () => {
    const settings = sonarSettings(
      { SONAR_HUB: '/opt/sonar-hub', SONAR_HOST_URL: 'http://localhost:9100/', SONAR_TOKEN_FILE: '/secrets/token' },
      '/home/invented',
    );
    assert.equal(settings.hostUrl, 'http://localhost:9100');
    assert.equal(settings.tokenFile, '/secrets/token');
  });
});

describe('keepAwake', () => {
  const fakeStart = (calls) => (command, args, options) => {
    calls.push({ command, args, options });
    return { on: () => {}, unref: () => {} };
  };

  it('holds off idle sleep on macOS until the process ends', () => {
    const calls = [];
    assert.notEqual(keepAwake('darwin', 4321, fakeStart(calls)), null);
    assert.deepEqual(calls, [{ command: '/usr/bin/caffeinate', args: ['-i', '-w', '4321'], options: { stdio: 'ignore' } }]);
  });

  it('starts nothing on another platform', () => {
    const calls = [];
    assert.equal(keepAwake('linux', 4321, fakeStart(calls)), null);
    assert.deepEqual(calls, []);
  });
});
