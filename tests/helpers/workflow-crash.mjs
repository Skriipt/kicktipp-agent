import { FileWorkflowStore } from '../../dist/workflow/store.js';
import { Workflow } from '../../dist/workflow/engine.js';
import { times } from '../../dist/workflow/model.js';
const [root, raw] = process.argv.slice(2);
const fixture = JSON.parse(raw);
const now = times(fixture).r1;
const source = {
  url: 'https://original.example/crash', text: 'Durable original', publishedAt: now,
  reliability: 'primary', scope: 'team', season: fixture.season,
  competition: fixture.competition, teams: [fixture.home], kind: 'current',
};
await new Workflow(new FileWorkflowStore(root), () => ({
  search: async () => [],
  open: async () => source,
  investigate: async (_, tools) => {
    await tools.open(source.url);
    await tools.record({ findings: [{
      url: source.url, category: 'news', team: fixture.home, subject: 'news',
      quote: source.text, claim: source.text,
    }], uncertainties: ['Crash checkpoint'] });
    process.send({ ready: true });
    return new Promise(() => {});
  },
}), { predict: async () => { throw new Error('unused'); } }, {
  submit: async () => { throw new Error('unused'); },
  read: async () => null,
}, { now: () => now, sleep: async () => {} }).tick(fixture);
