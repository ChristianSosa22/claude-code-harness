import {
  countLabels,
  firstVerdict,
  median,
  parseArgs,
  percentile,
  renderReport,
  reworkRate,
  specMetrics,
  type Deploy,
  type Metrics,
  type SpecCommit,
} from '../../scripts/harness-metrics';

const commit = (subject: string, over: Partial<SpecCommit> = {}): SpecCommit => ({
  subject,
  marksTaskDone: false,
  touchesSpec: true,
  onlyArchiveMove: false,
  scenarioLines: 0,
  ...over,
});

describe('specMetrics', () => {
  it('counts the planning rounds and the spec commits after the first task is done', () => {
    const result = specMetrics('sample-change', [
      commit('docs: propose sample-change'),
      commit('spec(sample-change): round 1 — add the filter'),
      commit('spec(sample-change): round 2 — remove the export'),
      commit('feat: group 1', { marksTaskDone: true }),
      commit('spec(sample-change) [ui]: the button goes to the top', { scenarioLines: 2 }),
      commit('spec(sample-change) [edge-case]: a day with no data', { scenarioLines: 1 }),
      commit('docs: mark group 2', { touchesSpec: false }),
      commit('docs: archive sample-change', { onlyArchiveMove: true }),
    ]);
    expect(result).toEqual({
      change: 'sample-change',
      started: true,
      revisionRounds: 2,
      planningSpecCommits: 3,
      postBuildSpecCommits: 2,
      postBuildScenarioLines: 3,
      causes: { ui: 1, 'edge-case': 1 },
    });
  });

  it('reads the Spanish subjects of projects that started with the earlier template', () => {
    const result = specMetrics('legacy-change', [
      commit('spec(legacy-change): ronda 1 — primera versión'),
      commit('feat: grupo 1', { marksTaskDone: true }),
      commit('spec(legacy-change) [caso-borde]: día sin datos'),
      commit('spec(legacy-change) [alcance]: quita la exportación'),
    ]);
    expect(result.revisionRounds).toBe(1);
    expect(result.causes).toEqual({ 'edge-case': 1, scope: 1 });
  });

  it('leaves the rounds without a record when no commit follows the rule', () => {
    const result = specMetrics('old', [commit('docs: propose old'), commit('feat: group 1', { marksTaskDone: true })]);
    expect(result.revisionRounds).toBeNull();
    expect(result.postBuildSpecCommits).toBe(0);
  });

  it('marks a change with no done task as not started', () => {
    expect(specMetrics('new', [commit('docs: propose new')]).started).toBe(false);
  });
});

describe('reworkRate', () => {
  const deploy = (sha: string, createdAt: string, over: Partial<Deploy> = {}): Deploy => ({ sha, createdAt, ref: 'main', succeeded: true, ...over });

  it('counts as rework a deploy with a fix within 72 hours of the previous one', () => {
    const subjects: Record<string, string[]> = { 'a..b': ['fix: correct the filter'], 'b..c': ['feat: new view'], 'c..d': ['fix: another'] };
    const result = reworkRate(
      [
        deploy('a', '2026-10-01T10:00:00Z'),
        deploy('b', '2026-10-02T10:00:00Z'),
        deploy('c', '2026-10-03T10:00:00Z'),
        deploy('x', '2026-10-04T10:00:00Z', { succeeded: false }),
        deploy('d', '2026-10-10T10:00:00Z'),
      ],
      (from, to) => subjects[`${from}..${to}`] ?? [],
    );
    expect(result).toEqual({ deploys: 4, reworkDeploys: 1, rate: 1 / 3, failedDeploys: 1 });
  });

  it('ignores deploys of other branches and deploys that repeat the same commit', () => {
    const result = reworkRate(
      [deploy('a', '2026-10-01T10:00:00Z'), deploy('a', '2026-10-01T11:00:00Z'), deploy('z', '2026-10-01T12:00:00Z', { ref: 'branch' })],
      () => ['fix: something'],
    );
    expect(result.reworkDeploys).toBe(0);
    expect(result.deploys).toBe(2);
  });
});

describe('helpers', () => {
  it('reads the first verdict of the reviewer report', () => {
    expect(firstVerdict('VERDICT: FAIL\n- scenario: PASS')).toBe('FAIL');
    expect(firstVerdict('**VERDICT:** PASS')).toBe('PASS');
    expect(firstVerdict('VERDICT: DIFF TOO LARGE')).toBe('TOO_BIG');
    expect(firstVerdict('no verdict')).toBeNull();
  });

  it('reads the Spanish verdict of the earlier reviewer', () => {
    expect(firstVerdict('VEREDICTO: FAIL')).toBe('FAIL');
    expect(firstVerdict('VEREDICTO: DIFF DEMASIADO GRANDE')).toBe('TOO_BIG');
  });

  it('calculates the median, the percentile, and the count of labels', () => {
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(30);
    expect(countLabels(['a', 'b', 'a', undefined])).toEqual({ a: 2, b: 1 });
  });

  it('uses 28 days before today when it gets no --since', () => {
    expect(parseArgs([], '2026-11-10')).toEqual({ since: '2026-10-13', classify: true });
    expect(parseArgs(['--since=2026-10-07', '--no-classify'], '2026-11-10')).toEqual({ since: '2026-10-07', classify: false });
    expect(() => parseArgs(['--since=yesterday'], '2026-11-10')).toThrow('is not YYYY-MM-DD');
  });
});

describe('renderReport', () => {
  const metrics: Metrics = {
    since: '2026-10-13',
    until: '2026-11-10',
    changes: [
      { change: 'one', started: true, revisionRounds: 2, planningSpecCommits: 2, postBuildSpecCommits: 0, postBuildScenarioLines: 0, causes: {} },
      { change: 'two', started: true, revisionRounds: null, planningSpecCommits: 1, postBuildSpecCommits: 3, postBuildScenarioLines: 4, causes: { ux: 2 } },
    ],
    rework: { deploys: 11, reworkDeploys: 1, rate: 0.1, failedDeploys: 0 },
    reviewer: { reviews: 20, fail: 5, tooBig: 0, failTypes: { 'functional-bug': 3, 'style-rule': 1 } },
    prompts: { total: 100, interrupts: 1, types: { 'new-task': 60, correction: 4 } },
    context: { calls: 10, mean: 120_000, p50: 100_000, p90: 200_000, compactions: 1, sessions: 2 },
  };

  it('shows each metric with its value, its target, and its status', () => {
    const report = renderReport(metrics);
    expect(report).toContain('| 1. Spec first-pass yield | 50 % (1 of 2 changes with no spec edit after the start) | ≥ 60 % | ⚠️ |');
    expect(report).toContain('| 2. Review rounds in planning | median 2 (1 changes with a record) | ≤ 3 | ✅ |');
    expect(report).toContain('| 3. Rework in prod | 10 % (1 of 10 deploys; 0 failed) | < 10 % | ⚠️ |');
    expect(report).toContain('| 4a. Reviewer FAIL on the first verdict | 25 % (5 of 20) | 15 %–30 % | ✅ |');
    expect(report).toContain('| 4b. FAIL with a substantive finding | 75 % (4 classified) | ≥ 70 % | ✅ |');
    expect(report).toContain('| 5. Corrections per prompt | 6 % (4 of 64; 1 interrupts) | < 5 % | ⚠️ |');
    expect(report).toContain('| 6. Context per call (main session) | mean 120k, p50 100k, p90 200k tokens | < 150k | ✅ |');
    expect(report).toContain('Causes after the start: ux 2.');
  });

  it('marks as not classified the metrics that need the model when it runs with --no-classify', () => {
    const report = renderReport({ ...metrics, reviewer: { ...metrics.reviewer, failTypes: null }, prompts: { ...metrics.prompts, types: null } });
    expect(report).toContain('| 4b. FAIL with a substantive finding | not classified | ≥ 70 % | ➖ |');
    expect(report).toContain('| 5. Corrections per prompt | not classified | < 5 % | ➖ |');
  });
});
