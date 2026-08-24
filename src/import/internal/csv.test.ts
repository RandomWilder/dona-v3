import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KernelError } from '../../kernel/errors.ts';
import { parseCsv } from './csv.ts';

const invalid = (error: KernelError) => error.code === 'invalid';

describe('csv parsing', () => {
  it('reads a plain table', () => {
    const table = parseCsv('a,b\n1,2\n3,4\n');
    assert.deepEqual(table.header, ['a', 'b']);
    assert.deepEqual(table.rows, [
      { line: 2, values: { a: '1', b: '2' } },
      { line: 3, values: { a: '3', b: '4' } },
    ]);
  });

  it('reads a last row with no trailing newline', () => {
    const table = parseCsv('a,b\n1,2');
    assert.equal(table.rows.length, 1);
    assert.deepEqual(table.rows[0]?.values, { a: '1', b: '2' });
  });

  // A spreadsheet exporting Hebrew writes a BOM, and it lands on the first
  // header name, where it would silently break every lookup by column.
  it('strips a UTF-8 BOM', () => {
    const table = parseCsv('﻿city,street\nתל אביב,הרצל\n');
    assert.deepEqual(table.header, ['city', 'street']);
    assert.deepEqual(table.rows[0]?.values, {
      city: 'תל אביב',
      street: 'הרצל',
    });
  });

  it('reads CRLF as a line ending, not as data', () => {
    const table = parseCsv('a,b\r\n1,2\r\n');
    assert.deepEqual(table.rows[0]?.values, { a: '1', b: '2' });
  });

  it('keeps a comma inside a quoted field', () => {
    const table = parseCsv('a,b\n"הרצל 12, דירה 3",x\n');
    assert.equal(table.rows[0]?.values.a, 'הרצל 12, דירה 3');
    assert.equal(table.rows[0]?.values.b, 'x');
  });

  it('reads a doubled quote as one quote', () => {
    const table = parseCsv('a\n"say ""hi"""\n');
    assert.equal(table.rows[0]?.values.a, 'say "hi"');
  });

  // The line number is what a reject reports, so it has to count the physical
  // lines a quoted newline spans -- otherwise every later reject points at the
  // wrong row in the file the operator is looking at.
  it('counts lines through a quoted newline', () => {
    const table = parseCsv('a,b\n"one\ntwo",x\nlast,y\n');
    assert.equal(table.rows[0]?.line, 2);
    assert.equal(table.rows[0]?.values.a, 'one\ntwo');
    assert.equal(table.rows[1]?.line, 4);
    assert.equal(table.rows[1]?.values.a, 'last');
  });

  it('skips a blank line rather than calling it a row', () => {
    const table = parseCsv('a,b\n1,2\n\n3,4\n');
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[1]?.line, 4);
  });

  it('keeps an empty field as an empty string', () => {
    const table = parseCsv('a,b,c\n1,,3\n');
    assert.deepEqual(table.rows[0]?.values, { a: '1', b: '', c: '3' });
  });

  describe('structural failures', () => {
    it('refuses a ragged row, naming its line', () => {
      assert.throws(
        () => parseCsv('a,b\n1,2\n3\n'),
        (error: KernelError) => {
          assert.equal(error.code, 'invalid');
          assert.equal(error.details?.line, 3);
          return true;
        },
      );
    });

    it('refuses an unterminated quote', () => {
      assert.throws(() => parseCsv('a\n"never closed\n'), invalid);
    });

    it('refuses an empty file', () => {
      assert.throws(() => parseCsv(''), invalid);
    });

    it('refuses an unnamed or repeated column', () => {
      assert.throws(() => parseCsv('a,,b\n1,2,3\n'), invalid);
      assert.throws(() => parseCsv('a,b,a\n1,2,3\n'), invalid);
    });

    it('refuses anything that is not text', () => {
      for (const value of [undefined, null, 7, {}]) {
        assert.throws(() => parseCsv(value), invalid);
      }
    });
  });

  it('trims header names but not values', () => {
    const table = parseCsv(' a , b \n 1 , 2 \n');
    assert.deepEqual(table.header, ['a', 'b']);
    assert.equal(table.rows[0]?.values.a, ' 1 ');
  });
});
