import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

export const POST_BUILD_CAUSES = ['ui', 'ux', 'edge-case', 'scope', 'spec-error'] as const;
export type PostBuildCause = (typeof POST_BUILD_CAUSES)[number];

// Projects that started with the Spanish template keep their commit subjects; map them so their history still counts.
const LEGACY_CAUSES: Record<string, PostBuildCause> = { 'caso-borde': 'edge-case', alcance: 'scope', 'error-spec': 'spec-error' };

export const REVIEW_FINDING_TYPES = ['functional-bug', 'spec-gap', 'missing-test', 'security-data', 'style-rule'] as const;
export type ReviewFindingType = (typeof REVIEW_FINDING_TYPES)[number];

export const PROMPT_TYPES = ['new-task', 'go-ahead', 'info', 'correction', 'question'] as const;
export type PromptType = (typeof PROMPT_TYPES)[number];

export const TARGETS = {
  specFirstPassYield: 0.6,
  revisionRoundsMedian: 3,
  reworkRate: 0.1,
  reviewerFailMin: 0.15,
  reviewerFailMax: 0.3,
  reviewerSubstantiveMin: 0.7,
  correctionShare: 0.05,
  contextPerCallMean: 150_000,
} as const;

// A deploy that ships one of these within 72 hours of the previous one counts as rework (DORA rework rate proxy).
const FIX_SUBJECT = /\b(fix|hotfix|revert|corrige|arregla|repara)/i;
const REWORK_WINDOW_HOURS = 72;
const ROUND_SUBJECT = /^spec\([^)]+\): (round|ronda) \d+/;
const CAUSE_SUBJECT = new RegExp(`^spec\\([^)]+\\) \\[(${[...POST_BUILD_CAUSES, ...Object.keys(LEGACY_CAUSES)].join('|')})\\]`);

export interface SpecCommit {
  subject: string;
  marksTaskDone: boolean;
  touchesSpec: boolean;
  onlyArchiveMove: boolean;
  scenarioLines: number;
}

export interface ChangeSpecMetrics {
  change: string;
  started: boolean;
  revisionRounds: number | null;
  planningSpecCommits: number;
  postBuildSpecCommits: number;
  postBuildScenarioLines: number;
  causes: Partial<Record<PostBuildCause, number>>;
}

export function specMetrics(change: string, commits: SpecCommit[]): ChangeSpecMetrics {
  const start = commits.findIndex((c) => c.marksTaskDone);
  const planning = start < 0 ? commits : commits.slice(0, start);
  const post = start < 0 ? [] : commits.slice(start + 1).filter((c) => c.touchesSpec && !c.onlyArchiveMove);
  const rounds = planning.filter((c) => ROUND_SUBJECT.test(c.subject)).length;
  const causes: Partial<Record<PostBuildCause, number>> = {};
  for (const commit of post) {
    const label = CAUSE_SUBJECT.exec(commit.subject)?.[1];
    const cause = label === undefined ? undefined : LEGACY_CAUSES[label] ?? (label as PostBuildCause);
    if (cause) causes[cause] = (causes[cause] ?? 0) + 1;
  }
  return {
    change,
    started: start >= 0,
    revisionRounds: rounds > 0 ? rounds : null,
    planningSpecCommits: planning.filter((c) => c.touchesSpec).length,
    postBuildSpecCommits: post.length,
    postBuildScenarioLines: post.reduce((sum, c) => sum + c.scenarioLines, 0),
    causes,
  };
}

export interface Deploy {
  sha: string;
  createdAt: string;
  ref: string;
  succeeded: boolean;
}

export interface ReworkResult {
  deploys: number;
  reworkDeploys: number;
  rate: number | null;
  failedDeploys: number;
}

export function reworkRate(deploys: Deploy[], subjectsBetween: (from: string, to: string) => string[]): ReworkResult {
  const sorted = [...deploys].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const ok = sorted.filter((d) => d.succeeded && d.ref === 'main');
  let rework = 0;
  for (let i = 1; i < ok.length; i++) {
    const prev = ok[i - 1]!;
    const curr = ok[i]!;
    if (prev.sha === curr.sha) continue;
    const hours = (Date.parse(curr.createdAt) - Date.parse(prev.createdAt)) / 3_600_000;
    if (hours <= REWORK_WINDOW_HOURS && subjectsBetween(prev.sha, curr.sha).some((s) => FIX_SUBJECT.test(s))) rework++;
  }
  return {
    deploys: ok.length,
    reworkDeploys: rework,
    rate: ok.length > 1 ? rework / (ok.length - 1) : null,
    failedDeploys: sorted.filter((d) => !d.succeeded).length,
  };
}

export function firstVerdict(report: string): 'PASS' | 'FAIL' | 'TOO_BIG' | null {
  const match = /(?:VERDICT|VEREDICTO)\W*(PASS|FAIL|DIFF TOO LARGE|DIFF DEMASIADO GRANDE)/.exec(report);
  if (!match) return null;
  return match[1] === 'PASS' || match[1] === 'FAIL' ? match[1] : 'TOO_BIG';
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function countLabels<T extends string>(labels: (T | undefined)[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const label of labels) if (label) counts[label] = (counts[label] ?? 0) + 1;
  return counts;
}

export interface Metrics {
  since: string;
  until: string;
  changes: ChangeSpecMetrics[];
  rework: ReworkResult | null;
  reviewer: { reviews: number; fail: number; tooBig: number; failTypes: Partial<Record<ReviewFindingType, number>> | null };
  prompts: { total: number; interrupts: number; types: Partial<Record<PromptType, number>> | null };
  context: { calls: number; mean: number | null; p50: number | null; p90: number | null; compactions: number; sessions: number };
}

const pct = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(0)} %`);
const status = (ok: boolean | null): string => (ok === null ? '➖' : ok ? '✅' : '⚠️');

export function renderReport(m: Metrics): string {
  const finished = m.changes.filter((c) => c.started);
  const oneShot = finished.filter((c) => c.postBuildSpecCommits === 0).length;
  const yieldRate = finished.length ? oneShot / finished.length : null;
  const rounds = finished.map((c) => c.revisionRounds).filter((r): r is number => r !== null);
  const roundsMedian = median(rounds);
  const judged = m.reviewer.reviews - m.reviewer.tooBig;
  const failRate = judged > 0 ? m.reviewer.fail / judged : null;
  const typed = m.reviewer.failTypes ? Object.values(m.reviewer.failTypes).reduce((a, b) => a + b, 0) : 0;
  const substantive = m.reviewer.failTypes && typed > 0 ? 1 - (m.reviewer.failTypes['style-rule'] ?? 0) / typed : null;
  const classified = m.prompts.types ? Object.values(m.prompts.types).reduce((a, b) => a + b, 0) : 0;
  const corrections = m.prompts.types && classified > 0 ? (m.prompts.types.correction ?? 0) / classified : null;
  const causes = countLabels(finished.flatMap((c) => Object.entries(c.causes).flatMap(([k, n]) => Array<PostBuildCause>(n).fill(k as PostBuildCause))));

  const rows: string[][] = [
    ['1. Spec first-pass yield', `${pct(yieldRate)} (${oneShot} of ${finished.length} changes with no spec edit after the start)`, `≥ ${pct(TARGETS.specFirstPassYield)}`, status(yieldRate === null ? null : yieldRate >= TARGETS.specFirstPassYield)],
    ['2. Review rounds in planning', roundsMedian === null ? 'no record (the commit rule `spec(<change>): round N` is missing)' : `median ${roundsMedian} (${rounds.length} changes with a record)`, `≤ ${TARGETS.revisionRoundsMedian}`, status(roundsMedian === null ? null : roundsMedian <= TARGETS.revisionRoundsMedian)],
    ['3. Rework in prod', m.rework ? `${pct(m.rework.rate)} (${m.rework.reworkDeploys} of ${Math.max(0, m.rework.deploys - 1)} deploys; ${m.rework.failedDeploys} failed)` : 'no GitHub data', `< ${pct(TARGETS.reworkRate)}`, status(m.rework?.rate == null ? null : m.rework.rate < TARGETS.reworkRate)],
    ['4a. Reviewer FAIL on the first verdict', `${pct(failRate)} (${m.reviewer.fail} of ${judged})`, `${pct(TARGETS.reviewerFailMin)}–${pct(TARGETS.reviewerFailMax)}`, status(failRate === null ? null : failRate >= TARGETS.reviewerFailMin && failRate <= TARGETS.reviewerFailMax)],
    ['4b. FAIL with a substantive finding', substantive === null ? 'not classified' : `${pct(substantive)} (${typed} classified)`, `≥ ${pct(TARGETS.reviewerSubstantiveMin)}`, status(substantive === null ? null : substantive >= TARGETS.reviewerSubstantiveMin)],
    ['5. Corrections per prompt', corrections === null ? 'not classified' : `${pct(corrections)} (${m.prompts.types?.correction ?? 0} of ${classified}; ${m.prompts.interrupts} interrupts)`, `< ${pct(TARGETS.correctionShare)}`, status(corrections === null ? null : corrections < TARGETS.correctionShare)],
    ['6. Context per call (main session)', m.context.mean === null ? '—' : `mean ${Math.round(m.context.mean / 1000)}k, p50 ${Math.round((m.context.p50 ?? 0) / 1000)}k, p90 ${Math.round((m.context.p90 ?? 0) / 1000)}k tokens`, `< ${TARGETS.contextPerCallMean / 1000}k`, status(m.context.mean === null ? null : m.context.mean < TARGETS.contextPerCallMean)],
  ];

  const lines = [
    `# Harness metrics: ${m.since} to ${m.until}`,
    '',
    '| Metric | Value | Target | Status |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
    '## Changes archived in the window',
    '',
    '| Change | Rounds in planning | Spec commits in planning | Spec commits after the start | Scenario lines after the start | Causes |',
    '|---|---|---|---|---|---|',
    ...finished.map((c) => `| ${c.change} | ${c.revisionRounds ?? '—'} | ${c.planningSpecCommits} | ${c.postBuildSpecCommits} | ${c.postBuildScenarioLines} | ${Object.entries(c.causes).map(([k, n]) => `${k} ${n}`).join(', ') || '—'} |`),
    '',
    `Causes after the start: ${Object.entries(causes).map(([k, n]) => `${k} ${n}`).join(', ') || 'no labels yet'}.`,
    '',
    '## Detail',
    '',
    `- Types of reviewer FAIL: ${m.reviewer.failTypes ? Object.entries(m.reviewer.failTypes).map(([k, n]) => `${k} ${n}`).join(', ') : 'not classified'}.`,
    `- Types of prompt: ${m.prompts.types ? Object.entries(m.prompts.types).map(([k, n]) => `${k} ${n}`).join(', ') : 'not classified'} (total ${m.prompts.total}).`,
    `- Sessions: ${m.context.sessions}; compactions: ${m.context.compactions}; calls of the main session: ${m.context.calls}.`,
    '',
    'Definitions, targets, and sources: `docs/harness-metrics.md`.',
    '',
  ];
  return lines.join('\n');
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, DEVELOPER_DIR: process.env['DEVELOPER_DIR'] ?? '/Library/Developer/CommandLineTools' },
  });
}

function archivedChanges(repo: string, since: string): string[] {
  return git(repo, 'ls-tree', '-d', '--name-only', 'origin/main', 'openspec/changes/archive/')
    .split('\n')
    .map((p) => basename(p))
    .filter((name) => /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(0, 10) >= since);
}

function specCommits(repo: string, archived: string): SpecCommit[] {
  const change = archived.slice(11);
  const log = git(repo, 'log', 'origin/main', '--reverse', '--no-merges', '--format=%x1eCOMMIT %s', '-p', '--unified=0', '--',
    `openspec/changes/${change}/`, `openspec/changes/archive/${archived}/`);
  return log.split('\x1eCOMMIT ').slice(1).map((block) => {
    const [subject = '', ...rest] = block.split('\n');
    const body = rest.join('\n');
    const files = [...body.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((f) => f[1]!);
    const specFiles = files.filter((f) => !f.endsWith('tasks.md') && !f.endsWith('.openspec.yaml'));
    return {
      subject,
      marksTaskDone: files.some((f) => f.endsWith('tasks.md')) && /^\+.*- \[x\]/m.test(body),
      touchesSpec: specFiles.length > 0,
      onlyArchiveMove: files.length > 0 && files.every((f) => f.includes('/archive/')),
      scenarioLines: (body.match(/^[+-]#### Scenario:/gm) ?? []).length,
    };
  });
}

function prodDeploys(repo: string, since: string): Deploy[] | null {
  const run = (path: string): string | null => {
    const out = spawnSync('gh', ['api', path], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.status === 0 ? out.stdout : null;
  };
  const raw = run('repos/{owner}/{repo}/deployments?environment=prod&per_page=100');
  if (!raw) return null;
  const list = JSON.parse(raw) as { sha: string; ref: string; created_at: string; statuses_url: string }[];
  return list
    .filter((d) => d.created_at.slice(0, 10) >= since)
    .map((d) => {
      const statuses = JSON.parse(run(d.statuses_url.replace('https://api.github.com/', '')) ?? '[]') as { state: string }[];
      return { sha: d.sha, ref: d.ref, createdAt: d.created_at, succeeded: statuses[0]?.state === 'success' };
    });
}

interface TranscriptData {
  prompts: string[];
  interrupts: number;
  contextPerCall: number[];
  compactions: number;
  sessions: number;
  reviewerReports: string[];
}

const SKIPPED_PROMPT = ['<command-', '<local-command', '<task-notification>', '[Request interrupted', 'Caveat:', '<bash-', '<system-reminder>'];

function readTranscripts(root: string, match: string, since: string): TranscriptData {
  const data: TranscriptData = { prompts: [], interrupts: 0, contextPerCall: [], compactions: 0, sessions: 0, reviewerReports: [] };
  const seen = new Set<string>();
  for (const dir of readdirSync(root).filter((d) => d.includes(match))) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.jsonl'))) {
      let inWindow = false;
      for (const line of readFileSync(join(root, dir, file), 'utf8').split('\n')) {
        if (!line) continue;
        let entry: Record<string, any>;
        try { entry = JSON.parse(line); } catch { continue; }
        if (typeof entry['timestamp'] !== 'string' || entry['timestamp'].slice(0, 10) < since) continue;
        inWindow = true;
        if (entry['type'] === 'user') {
          if (entry['isCompactSummary']) { data.compactions++; continue; }
          const content = entry['message']?.content;
          const text: string = typeof content === 'string' ? content
            : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ') : '';
          if (text.includes('[Request interrupted')) data.interrupts++;
          if (!text.trim() || entry['isMeta'] || SKIPPED_PROMPT.some((p) => text.trimStart().startsWith(p))) continue;
          data.prompts.push(text.slice(0, 400));
        } else if (entry['type'] === 'assistant') {
          const id: string | undefined = entry['message']?.id;
          const usage = entry['message']?.usage;
          if (!id || !usage || seen.has(id)) continue;
          seen.add(id);
          data.contextPerCall.push((usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0));
        }
      }
      if (inWindow) data.sessions++;
      const subagents = join(root, dir, file.replace(/\.jsonl$/, ''), 'subagents');
      if (existsSync(subagents)) data.reviewerReports.push(...reviewerReports(subagents, since));
    }
  }
  return data;
}

const REVIEWER_AGENTS = new Set(['reviewer', 'revisor', 'revisor-qa']);

function reviewerReports(folder: string, since: string): string[] {
  const reports: string[] = [];
  for (const meta of readdirSync(folder).filter((f) => f.endsWith('.meta.json'))) {
    if (!REVIEWER_AGENTS.has(JSON.parse(readFileSync(join(folder, meta), 'utf8'))['agentType'])) continue;
    for (const line of readFileSync(join(folder, meta.replace('.meta.json', '.jsonl')), 'utf8').split('\n')) {
      if (!line.includes('SubagentHandback')) continue;
      const entry = JSON.parse(line);
      const content = entry.message?.content;
      if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
      if (typeof entry.timestamp !== 'string' || entry.timestamp.slice(0, 10) < since) break;
      const handback = content.find((c: any) => c?.type === 'tool_use' && c.name === 'SubagentHandback');
      if (handback) { reports.push(String(handback.input?.message ?? '')); break; }
    }
  }
  return reports;
}

// Labels are cached by hash outside the repository: prompts and review reports can hold real data and must not
// reach a committed file.
const CACHE = join(homedir(), '.claude', 'harness-metrics', 'labels.json');

function classify<T extends string>(kind: string, texts: string[], allowed: readonly T[], instructions: string): (T | undefined)[] {
  const cache: Record<string, string> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
  const key = (t: string) => createHash('sha256').update(`${kind}\n${t}`).digest('hex');
  const missing = texts.map((t, i) => ({ t, i })).filter(({ t }) => !cache[key(t)]);
  for (let b = 0; b < missing.length; b += 8) {
    const batch = missing.slice(b, b + 8);
    const body = batch.map(({ t }, j) => `### ITEM ${j}\n${t}`).join('\n\n');
    const system = `${instructions} Labels: ${allowed.map((a) => `"${a}"`).join(', ')}. Answer ONLY a JSON array like [{"i":0,"label":"${allowed[0]}"}] with one entry per ITEM.`;
    const out = spawnSync('claude', ['-p', '--model', 'haiku', '--no-session-persistence', '--system-prompt', system], { input: body, encoding: 'utf8', timeout: 300_000 });
    const json = /\[[\s\S]*\]/.exec(out.stdout ?? '')?.[0];
    if (!json) continue;
    for (const r of JSON.parse(json) as { i: number; label: string }[]) {
      const item = batch[r.i];
      if (item && (allowed as readonly string[]).includes(r.label)) cache[key(item.t)] = r.label;
    }
  }
  mkdirSync(join(homedir(), '.claude', 'harness-metrics'), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));
  return texts.map((t) => cache[key(t)] as T | undefined);
}

export function parseArgs(argv: string[], today: string): { since: string; classify: boolean } {
  const sinceArg = argv.find((a) => a.startsWith('--since='))?.slice(8);
  const since = sinceArg ?? new Date(Date.parse(today) - 28 * 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`--since "${since}" is not YYYY-MM-DD`);
  return { since, classify: !argv.includes('--no-classify') };
}

function main(): void {
  const today = new Date().toISOString().slice(0, 10);
  const { since, classify: useLlm } = parseArgs(process.argv.slice(2), today);
  const transcripts = join(homedir(), '.claude', 'projects');
  if (!existsSync(transcripts)) {
    process.stderr.write(`harness-metrics found no Claude Code transcripts in ${transcripts}\n`);
    process.exit(2);
  }
  const repo = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const mainWorktree = git(repo, 'worktree', 'list', '--porcelain').split('\n')[0]!.replace('worktree ', '');
  git(repo, 'fetch', '-q', 'origin');

  const changes = archivedChanges(repo, since).map((a) => specMetrics(a.slice(11), specCommits(repo, a)));
  const deploys = prodDeploys(repo, since);
  const rework = deploys
    ? reworkRate(deploys, (from, to) => git(repo, 'log', '--no-merges', '--format=%s', `${from}..${to}`).split('\n').filter(Boolean))
    : null;
  const t = readTranscripts(transcripts, basename(mainWorktree), since);
  const verdicts = t.reviewerReports.map(firstVerdict);
  const failReports = t.reviewerReports.filter((_, i) => verdicts[i] === 'FAIL').map((r) => r.slice(0, 2500));

  const failTypes = useLlm ? countLabels(classify('review', failReports, REVIEW_FINDING_TYPES,
    'Each ITEM is a code-review report with verdict FAIL. Give the label of its MOST SEVERE finding: functional-bug = wrong behavior or would break at runtime or deploy; spec-gap = a scenario or design rule missing or different; missing-test = a scenario without a test that proves it; security-data = secrets, masking, IAM or real data in fixtures; style-rule = comments, naming, language or format rules only.')) : null;
  const promptTypes = useLlm ? countLabels(classify('prompt', t.prompts, PROMPT_TYPES,
    'Each ITEM is a message a developer sent to an AI coding agent. new-task = asks for new work; go-ahead = approves or says continue; info = gives facts or answers the agent; correction = says the agent did something wrong, misunderstood, or must redo or undo; question = asks for status or an explanation.')) : null;

  const report = renderReport({
    since,
    until: today,
    changes,
    rework,
    reviewer: { reviews: verdicts.filter(Boolean).length, fail: failReports.length, tooBig: verdicts.filter((v) => v === 'TOO_BIG').length, failTypes },
    prompts: { total: t.prompts.length, interrupts: t.interrupts, types: promptTypes },
    context: { calls: t.contextPerCall.length, mean: t.contextPerCall.length ? t.contextPerCall.reduce((a, b) => a + b, 0) / t.contextPerCall.length : null, p50: percentile(t.contextPerCall, 0.5), p90: percentile(t.contextPerCall, 0.9), compactions: t.compactions, sessions: t.sessions },
  });
  const outDir = join(homedir(), '.claude', 'harness-metrics');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${today}.md`);
  writeFileSync(outFile, report);
  process.stdout.write(`${report}\nReport saved to ${outFile}\n`);
}

if (require.main === module) main();
