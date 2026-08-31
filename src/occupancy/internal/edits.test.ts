import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyEdits, EditError, editableGroups } from './edits.ts';

// Pure, no database. What these prove is the rule the whole review surface rests
// on: a reviewer may change a value and may drop a row, and may never touch a
// citation.

const securities = {
  items: [
    {
      kind: 'פיקדון',
      statedAmount: '10,000',
      statedText: 'הפקדה במזומן',
      chunkId: 'c1',
      clauseRef: 'נספח א׳ §8',
    },
    {
      kind: 'ערבות בנקאית',
      statedAmount: '10,000',
      statedText: 'ערבות אוטונומית',
      chunkId: 'c2',
      clauseRef: 'נספח ו׳ §2',
    },
  ],
};

const term = {
  initial: { from: '01.01.2026', to: '31.12.2027' },
  options: [
    {
      from: '01.01.2028',
      to: '31.12.2029',
      noticeBy: '30.09.2027',
      statedText: null,
      chunkId: 'c1',
      clauseRef: 'נספח א׳ §5',
    },
  ],
  capYears: 10,
  statedText: null,
};

describe('editableGroups', () => {
  it('follows a nested object into the field own block', () => {
    const [own] = editableGroups(term);
    assert.equal(own?.row, null);
    assert.deepEqual(
      own?.leaves.map((leaf) => leaf.path),
      ['initial.from', 'initial.to', 'capYears'],
    );
  });

  it('gives every row of a list its own block, with the row path', () => {
    const groups = editableGroups(securities);
    assert.deepEqual(
      groups.map((group) => group.row),
      ['items.0', 'items.1'],
    );
    assert.deepEqual(
      groups[1]?.leaves.map((leaf) => leaf.path),
      ['items.1.kind', 'items.1.statedAmount', 'items.1.statedText'],
    );
  });

  it('carries a row citation and never offers it as a leaf', () => {
    const groups = editableGroups(securities);
    assert.equal(groups[0]?.chunkId, 'c1');
    assert.equal(groups[0]?.clauseRef, 'נספח א׳ §8');
    assert.equal(
      groups.some((group) =>
        group.leaves.some(
          (leaf) =>
            leaf.path.endsWith('chunkId') || leaf.path.endsWith('clauseRef'),
        ),
      ),
      false,
    );
  });

  it('keeps a count of days a number and a stated figure text', () => {
    const [own] = editableGroups({ capYears: 10, statedText: 'עשר שנים' });
    assert.deepEqual(
      own?.leaves.map((leaf) => [leaf.path, leaf.kind]),
      [
        ['capYears', 'number'],
        ['statedText', 'text'],
      ],
    );
  });

  it('does not offer a leaf the extraction left null', () => {
    // Filling one in is stating something the clauses did not yield, which needs
    // a citation the reviewer would have to choose -- a surface this slice does
    // not build. See SPEC-occupancy.md, "may edit and may drop, and may not add".
    const [own] = editableGroups({ baseAmount: '4,250', currency: null });
    assert.deepEqual(
      own?.leaves.map((leaf) => leaf.path),
      ['baseAmount'],
    );
  });
});

describe('applyEdits', () => {
  it('changes only the leaf it was given, and does not touch the original', () => {
    const next = applyEdits(securities, { 'items.1.kind': 'שטר חוב' }, []);
    assert.equal(
      (next.items as Array<Record<string, unknown>>)[1]?.kind,
      'שטר חוב',
    );
    assert.equal(securities.items[1]?.kind, 'ערבות בנקאית');
  });

  it('keeps a number a number', () => {
    const next = applyEdits(term, { capYears: '12' }, []);
    assert.equal(next.capYears, 12);
  });

  it('refuses text where the contract stated a count', () => {
    assert.throws(
      () => applyEdits(term, { capYears: 'עשר' }, []),
      (error: unknown) => error instanceof EditError,
    );
  });

  it('reads an emptied box as "the contract does not state this"', () => {
    const next = applyEdits(term, { 'initial.to': '  ' }, []);
    assert.equal((next.initial as Record<string, unknown>).to, null);
  });

  it('drops the row it was told to and leaves the rest standing', () => {
    // The correction the real lease needs first: the annex offers a deposit *or*
    // a bank guarantee, and the twin read it as both.
    const next = applyEdits(securities, {}, ['items.1']);
    const rows = next.items as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, 'פיקדון');
  });

  it('applies an edit before a drop, so a path still means what it meant', () => {
    // Dropping row 0 first would silently move row 1's edit up one, and the
    // reviewer would have corrected a row they were not looking at.
    const next = applyEdits(securities, { 'items.1.kind': 'שטר חוב' }, [
      'items.0',
    ]);
    const rows = next.items as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, 'שטר חוב');
  });

  it('refuses an edit to a citation rather than ignoring it', () => {
    // Ignoring it would let a caller believe a citation had been changed.
    assert.throws(
      () => applyEdits(securities, { 'items.0.chunkId': 'c9' }, []),
      (error: unknown) => error instanceof EditError,
    );
  });

  it('ignores a path the stored value does not have', () => {
    // A path the form could not have rendered did not come from the form, and
    // nothing here creates structure out of one.
    const next = applyEdits(term, { 'options.7.from': '01.01.2030' }, []);
    assert.deepEqual(next, term);
  });
});
