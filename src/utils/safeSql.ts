/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import alasql from 'alasql';

// Runs read-only SQL over the active dataset in the browser. AlaSQL can also
// read and write files, fetch URLs and create tables, and SQL here may come
// from an AI model (which a crafted dataset could steer), so only a plain
// SELECT over the table `dataset` is allowed, in a fresh, private database.

export class SqlError extends Error {}

export const DEFAULT_ROW_LIMIT = 1000;

const FORBIDDEN_WORDS = [
  'INTO', 'CREATE', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'ATTACH', 'DETACH', 'USE', 'REQUIRE',
  'SOURCE', 'DECLARE', 'SET', 'EXEC', 'EXECUTE', 'TRUNCATE', 'REINDEX', 'ASSERT', 'SHOW', 'COMMIT',
  'ROLLBACK', 'BEGIN', 'MERGE', 'LOAD', 'SAVE', 'FILE', 'CSV', 'TSV', 'TAB', 'XLSX', 'XLS', 'JSON',
  'TXT', 'HTML', 'ODS', 'XML', 'GRAPH', 'MATCH', 'RECORDSET', 'INDEX', 'REPLACE', 'TRIGGER', 'PROCEDURE',
];
const FORBIDDEN_SYMBOLS: [RegExp, string][] = [
  [/`/, 'backticks'], [/->/, '“->”'], [/@/, '“@”'], [/[{}]/, 'braces'], [/\$/, '“$”'], [/\?/, '“?”'], [/!/, '“!”'],
];

/** The SQL with string literals and comments blanked out, so checks only see code. */
function codeOnly(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new SqlError('A comment (/* … */) is never closed.');
      i = end + 1;
      out += ' ';
    } else if (ch === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      if (j >= sql.length) throw new SqlError('A text value (in quotes) is never closed.');
      out += "''";
      i = j;
    } else if (ch === '"' || ch === '[') {
      // Quoted identifier: keep a placeholder name so table checks still work.
      const close = ch === '"' ? '"' : ']';
      const end = sql.indexOf(close, i + 1);
      if (end === -1) throw new SqlError('A quoted column name is never closed.');
      out += ` q_${sql.slice(i + 1, end).replace(/[^A-Za-z0-9_]/g, '_')} `;
      i = end;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Throws SqlError with a plain reason unless the SQL is a single read-only query on `dataset`. */
export function validateReadOnlySql(sql: string): void {
  if (!sql.trim()) throw new SqlError('Write a query first.');
  const code = codeOnly(sql).trim().replace(/;\s*$/, '');
  if (code.includes(';')) throw new SqlError('Run one query at a time.');
  if (!/^(SELECT|WITH)\b/i.test(code)) throw new SqlError('Only SELECT queries can run here; the data can’t be changed with SQL.');
  for (const [re, name] of FORBIDDEN_SYMBOLS) {
    if (re.test(code)) throw new SqlError(`${name} isn’t allowed in queries here.`);
  }
  const words = code.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  const bad = words.find(w => FORBIDDEN_WORDS.includes(w));
  if (bad) throw new SqlError(`“${bad}” isn’t allowed: queries here can only read the dataset.`);

  // Every table read must be `dataset` or a name defined in the WITH clause.
  const cteNames = new Set([...code.matchAll(/(?:WITH|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi)].map(m => m[1].toLowerCase()));
  for (const m of code.matchAll(/\b(?:FROM|JOIN)\s+([^\s(,)]+)/gi)) {
    const table = m[1].toLowerCase();
    if (table !== 'dataset' && !cteNames.has(table)) {
      throw new SqlError(`The only table is “dataset” (found “${m[1]}”).`);
    }
  }
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  columns: string[];
  /** Rows the query returned before the display limit. */
  total: number;
  truncated: boolean;
}

export function runReadOnlySql(sql: string, data: Record<string, unknown>[], limit = DEFAULT_ROW_LIMIT): SqlResult {
  validateReadOnlySql(sql);
  const db = new alasql.Database();
  db.exec('CREATE TABLE dataset');
  (db.tables as Record<string, { data: unknown[] }>).dataset.data = data.map(r => ({ ...r }));
  let out: unknown;
  try {
    out = db.exec(sql);
  } catch (err: any) {
    const message = String(err?.message || err);
    throw new SqlError(/Parse error/.test(message)
      ? `${message.split('\n').slice(0, 3).join('\n')}\nTip: if a name is also a SQL word (such as total, value or count), put it in [square brackets].`
      : message);
  }
  const all = Array.isArray(out) ? out.map(r => (r && typeof r === 'object' ? r : { value: r })) as Record<string, unknown>[] : [{ value: out }];
  const columns: string[] = [];
  all.slice(0, limit).forEach(r => Object.keys(r).forEach(k => { if (!columns.includes(k)) columns.push(k); }));
  return { rows: all.slice(0, limit), columns, total: all.length, truncated: all.length > limit };
}
