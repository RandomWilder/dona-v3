import { KernelError } from '../../kernel/errors.ts';

// Pure: no clock, no pool, no database — as identity's phone.ts and
// occupancy's roles.ts are. RFC 4180 with the concessions a real export makes.

export interface CsvRow {
  // 1-based line in the source file. This is what lets a reject name itself,
  // and it counts the physical lines a quoted newline spans.
  line: number;
  values: Record<string, string>;
}

export interface CsvTable {
  header: string[];
  rows: CsvRow[];
}

// A spreadsheet exporting Hebrew writes a BOM, and a spreadsheet on Windows
// writes CRLF. Both arrive attached to the first header name and the last field
// of every row respectively, so both are handled here rather than by every
// caller remembering to trim.
const bom = '﻿';

export function parseCsv(text: unknown): CsvTable {
  if (typeof text !== 'string') {
    throw new KernelError('invalid', 'csv must be text');
  }
  const records = splitRecords(text.startsWith(bom) ? text.slice(1) : text);
  const first = records[0];
  if (!first) {
    throw new KernelError('invalid', 'csv is empty');
  }

  const header = first.fields.map((name) => name.trim());
  if (header.some((name) => name === '')) {
    throw new KernelError('invalid', 'csv has an unnamed column', {
      line: first.line,
    });
  }
  const duplicate = header.find(
    (name, index) => header.indexOf(name) !== index,
  );
  if (duplicate !== undefined) {
    throw new KernelError('invalid', 'csv has a repeated column', {
      column: duplicate,
      line: first.line,
    });
  }

  const rows: CsvRow[] = [];
  for (const record of records.slice(1)) {
    // A trailing newline yields one empty field, which is a blank line and not
    // a row. Anything else with the wrong width is ragged and structural.
    if (record.fields.length === 1 && record.fields[0]?.trim() === '') {
      continue;
    }
    if (record.fields.length !== header.length) {
      throw new KernelError('invalid', 'csv row does not match the header', {
        line: record.line,
        expected: header.length,
        found: record.fields.length,
      });
    }
    const values: Record<string, string> = {};
    header.forEach((name, index) => {
      values[name] = record.fields[index] ?? '';
    });
    rows.push({ line: record.line, values });
  }
  return { header, rows };
}

interface CsvRecord {
  line: number;
  fields: string[];
}

// One pass, character by character. A quoted field may contain commas,
// newlines and doubled quotes; outside quotes a CR is only ever part of CRLF.
function splitRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    fields.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
    recordLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      if (char === '\n') {
        line += 1;
      }
      field += char;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      endField();
      continue;
    }
    if (char === '\r' && text[i + 1] === '\n') {
      continue;
    }
    if (char === '\n') {
      line += 1;
      endRecord();
      continue;
    }
    field += char;
  }
  if (quoted) {
    throw new KernelError('invalid', 'csv has an unterminated quote', { line });
  }
  // Whatever is left is the last record, unless the file ended on a newline.
  if (field !== '' || fields.length > 0) {
    endField();
    records.push({ line: recordLine, fields });
  }
  return records;
}
