// The importer's public surface. It is a tool rather than a domain module: it
// owns no tables and adds no invariants, and every write goes through
// identity, portfolio and occupancy contracts. See SPEC-import.md.

export type { CsvRow, CsvTable } from './internal/csv.ts';
export { parseCsv } from './internal/csv.ts';
export type {
  Actor,
  ImportDeps,
  ImportOptions,
  ImportReport,
  Rejection,
} from './internal/rows.ts';
export {
  importTenants,
  optionalColumns,
  requiredColumns,
} from './internal/rows.ts';
