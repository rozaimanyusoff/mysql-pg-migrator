export interface IncrementalFilter { col: string; gt?: string; pkCol?: string | null; pkGt?: string | null; }
export interface RangeFilter { col: string; from: string | null; to: string | null; }

export function cursorValue(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function buildWhere(
  dbType: 'postgresql' | 'mysql', inc?: IncrementalFilter, range?: RangeFilter,
): { where: string; params: unknown[]; orderCols: string[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const orderCols: string[] = [];
  const q = (col: string) => dbType === 'postgresql' ? `"${col}"` : `\`${col}\``;
  const p = () => dbType === 'postgresql' ? `$${params.length}` : '?';

  if (inc) {
    if (inc.gt != null && inc.pkCol && inc.pkGt != null) {
      params.push(inc.gt); const gtParam = p();
      params.push(inc.gt); const eqParam = p();
      params.push(inc.pkGt); const pkParam = p();
      conds.push(`(${q(inc.col)} > ${gtParam} OR (${q(inc.col)} = ${eqParam} AND ${q(inc.pkCol)} > ${pkParam}))`);
    } else if (inc.gt != null) {
      params.push(inc.gt);
      conds.push(`${q(inc.col)} > ${p()}`);
    }
    orderCols.push(inc.col);
    if (inc.pkCol) orderCols.push(inc.pkCol);
  }
  if (range?.from) {
    params.push(range.from);
    conds.push(`${q(range.col)} >= ${p()}`);
    if (!orderCols.length) orderCols.push(range.col);
  }
  if (range?.to) {
    params.push(range.to);
    conds.push(`${q(range.col)} <= ${p()}`);
    if (!orderCols.length) orderCols.push(range.col);
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params, orderCols };
}
