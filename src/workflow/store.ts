import fs from 'node:fs';
import path from 'node:path';
import { FileLock } from '../service/lock.js';
import { durableReplace } from '../service/store.js';
import { dossier, fixtureKey, fixtureSchema, stateSchema, sameFixture, times, type Fixture, type State } from './model.js';

export interface WorkflowStore {
  withFixture<T>(fixture: Fixture, work: (state: State, save: () => void) => Promise<T>): Promise<T>;
  read(fixture: Fixture): State;
}
// Injective encoding; dots, separators and Unicode cannot escape a directory.
const segment = (value: string) => Buffer.from(value).toString('hex');
export class FileWorkflowStore implements WorkflowStore {
  constructor(readonly root: string, readonly execution?: 'test') {}
  files(input: Fixture) {
    const f = fixtureSchema.parse(input);
    const dir = path.join(this.root, ...[f.season, f.competition, f.matchday, f.profile, f.community].map(segment));
    const base = path.join(dir, segment(f.fixtureId));
    return { state: `${base}.json`, dossier: `${base}.md`, lock: `${base}.lock` };
  }
  recover(): Fixture[] {
    if (!fs.existsSync(this.root)) return [];
    const fixtures: Fixture[] = [];
    for (const entry of fs.readdirSync(this.root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(entry.parentPath, entry.name);
      const state = stateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (path.resolve(file) !== path.resolve(this.files(state.fixture).state)) throw new Error('State path identity mismatch');
      const s = this.read(state.fixture);
      if ((s.status !== 'submitted' && s.status !== 'kickoff_passed')
        || s.notifications?.some(n => n.delivery === 'pending')) fixtures.push(s.fixture);
    }
    return fixtures;
  }
  read(input: Fixture): State {
    const f = fixtureSchema.parse(input);
    const s = stateSchema.parse(JSON.parse(fs.readFileSync(this.files(f).state, 'utf8')));
    if (s.execution !== this.execution) throw new Error('Workflow execution mode mismatch');
    if (fixtureKey(s.fixture) !== fixtureKey(f) || JSON.stringify(s.fixture) !== JSON.stringify(f)
      || JSON.stringify(s.times) !== JSON.stringify(times(f))) throw new Error('Fixture identity or schedule changed');
    for (const phase of ['r1', 'r2'] as const) {
      const r = s[phase];
      if (!r) continue;
      if (r.execution !== s.execution || r.fixtureKey !== fixtureKey(f) || r.phase !== phase || (r.fixture && !sameFixture(f, r.fixture))) {
        throw new Error('Research fixture identity changed');
      }
      // Only the verified containing state can establish identity of a legacy checkpoint.
      r.fixture ??= structuredClone(s.fixture);
    }
    return s;
  }
  async withFixture<T>(input: Fixture, work: (state: State, save: () => void) => Promise<T>): Promise<T> {
    const f = fixtureSchema.parse(input);
    const files = this.files(f);
    const lock = FileLock.acquire(files.lock);
    try {
      const s: State = fs.existsSync(files.state) ? this.read(f) : {
        version: 1, ...(this.execution ? { execution: this.execution } : {}), fixture: f, times: times(f), status: 'scheduled', history: [],
      };
      const save = () => {
        lock.assertHeld();
        stateSchema.parse(s);
        if (s.execution !== this.execution || [s.r1, s.r2].some(r => r && r.execution !== this.execution)) throw new Error('Workflow execution mode mismatch');
        durableReplace(files.state, JSON.stringify(s, null, 2) + '\n');
        durableReplace(files.dossier, dossier(s));
      };
      save(); // Also repairs a projection interrupted after the JSON commit.
      return await work(s, save);
    } finally { lock.release(); }
  }
}
