import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFics, authorTokens, normTitle } from './group.mjs';

const it = (o) => ({ title: 'x', ...o });
const idx = (groups) => groups.map((g) => g.map((v) => [...v].sort()));

test('same title, different authors: never grouped', () => {
  const g = groupFics([it({ title: 'Home', author: 'alice' }), it({ title: 'Home', author: 'bob' })]);
  assert.equal(g.length, 0);
});

test('same title and same author: grouped', () => {
  const g = groupFics([it({ title: 'Home', author: 'alice' }), it({ title: 'HOME!', author: 'Alice' })]);
  assert.equal(g.length, 1);
  assert.equal(g[0].flat().length, 2);
});

test('same title but one author unknown: not grouped (cannot verify)', () => {
  assert.equal(groupFics([it({ title: 'Home', author: 'alice' }), it({ title: 'Home' })]).length, 0);
});

test('pseud overlap counts as the same author', () => {
  assert.equal(authorTokens('RememberingRB19 (hellafunny33)').has('hellafunny33'), true);
  const g = groupFics([it({ title: 'Wait', author: 'Remembering (hellafunny33)' }), it({ title: 'Wait', author: 'hellafunny33' })]);
  assert.equal(g.length, 1);
});

test('anonymous is no information, not a shared author', () => {
  assert.equal(groupFics([it({ title: 'Boo', author: 'Anonymous' }), it({ title: 'Boo', author: 'Anonymous' })]).length, 0);
});

test('same AO3 id groups even if the title was renamed, unless the authors differ', () => {
  const same = groupFics([it({ title: 'Old name', ao3Id: '5', author: 'alice' }), it({ title: 'New name', ao3Id: '5', author: 'alice' })]);
  assert.equal(same.length, 1);
  const diff = groupFics([it({ title: 'Same', ao3Id: '5', author: 'alice' }), it({ title: 'Same', ao3Id: '5', author: 'bobby' })]);
  assert.equal(diff.length, 0);
  const unknown = groupFics([it({ title: 'Same', ao3Id: '5', author: 'alice' }), it({ title: 'Same', ao3Id: '5' })]);
  assert.equal(unknown.length, 1);
});

test('identical text is merged into one version with several locations', () => {
  const g = groupFics([it({ title: 'Alpha story', h: 'aa', author: 'xavier' }), it({ title: 'Alpha story', h: 'aa', author: 'xavier' }), it({ title: 'Alpha story', h: 'aa', author: 'xavier' })]);
  assert.equal(g.length, 1);
  assert.equal(g[0].length, 1); // one version
  assert.equal(g[0][0].length, 3); // three locations
});

test('any difference in the text makes a separate version, best first', () => {
  const g = groupFics([
    it({ title: 'Alpha story', h: 'v1', author: 'xavier', words: 1000, complete: false }),
    it({ title: 'Alpha story', h: 'v2', author: 'xavier', words: 5000, complete: true }),
    it({ title: 'Alpha story', h: 'v1', author: 'xavier', words: 1000, complete: false }),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].length, 2);
  assert.deepEqual(g[0][0], [1]); // complete, longest first
  assert.deepEqual(g[0][1].sort(), [0, 2]);
});

test('same work as epub and pdf with identical stats is one version; different stats are two', () => {
  const base = { title: 'Alpha story', author: 'xavier', ao3Id: '9' };
  const same = groupFics([it({ ...base, h: 'e1', hf: 'epub', sig: '100|2/2|2024-01-01' }), it({ ...base, h: 'p1', hf: 'pdf', sig: '100|2/2|2024-01-01' })]);
  assert.equal(same[0].length, 1);
  const diff = groupFics([it({ ...base, h: 'e1', hf: 'epub', sig: '100|2/2|2024-01-01' }), it({ ...base, h: 'p1', hf: 'pdf', sig: '90|1/2|2023-05-01' })]);
  assert.equal(diff[0].length, 2);
});

test('same format, same stats, different text: still two versions ("la moindre différence")', () => {
  const base = { title: 'Alpha story', author: 'xavier', ao3Id: '9', hf: 'epub', sig: '100|2/2|2024-01-01' };
  const g = groupFics([it({ ...base, h: 'e1' }), it({ ...base, h: 'e2' })]);
  assert.equal(g[0].length, 2);
});

test('copies that could not be fingerprinted are not assumed identical', () => {
  const g = groupFics([it({ title: 'Alpha story', author: 'xavier' }), it({ title: 'Alpha story', author: 'xavier' })]);
  assert.equal(g[0].length, 2);
});

test('a very generic title is not grouped by title alone', () => {
  const items = Array.from({ length: 70 }, () => it({ title: 'Home', author: 'alice' }));
  assert.equal(groupFics(items).length, 0);
});

test('authors never chain across a group: A~B (title) and B~C (id) but A and C differ', () => {
  const items = [
    it({ title: 'Title one', author: 'alice', ao3Id: '1' }),
    it({ title: 'Title one', author: 'alice (bob)', ao3Id: '2' }),
    it({ title: 'Title two', author: 'carol', ao3Id: '2' }), // same id as #1b but another author
  ];
  const g = groupFics(items);
  assert.equal(g.length, 1);
  assert.deepEqual(idx(g)[0].flat().sort(), [0, 1]); // carol is left alone
});

test('normTitle ignores case, accents and punctuation', () => {
  assert.equal(normTitle('Café — Au Lait!'), 'cafe au lait');
});
