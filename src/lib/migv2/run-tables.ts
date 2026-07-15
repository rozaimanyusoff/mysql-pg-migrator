import type { TableMap } from './types';

export function prepareRunTables(tables: TableMap[], options: { truncate?: boolean } = {}): TableMap[] {
  return tables
    .filter(t => t.include)
    .map(t => ({
      ...t,
      truncateBeforeMigrate: options.truncate === true,
      skipConstraints: false,
      skipNullViolations: false,
    }));
}
