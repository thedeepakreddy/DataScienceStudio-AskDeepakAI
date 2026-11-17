/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { datasetFromRecords, parseCSV, uniqueHeaders } from './csvParser';

// Reads a data file in the browser: CSV/TSV/TXT, Excel (.xlsx), JSON and
// Parquet. Everything is parsed locally; nothing is uploaded.

export const ACCEPTED_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx', '.json', '.jsonl', '.ndjson', '.parquet'];
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');
/** Larger files make the browser slow; the limit is stated, not silent. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_ROWS = 200_000;

export class ImportError extends Error {}

const ext = (name: string) => name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';

export interface ImportOptions {
  /** Excel sheet name; the first sheet when omitted. */
  sheet?: string;
}

export interface ImportResult {
  dataset: Dataset;
  /** Excel only: every sheet name, so another can be picked. */
  sheets?: string[];
  /** Notes about what the importer did (e.g. rows over the limit dropped). */
  notes: string[];
}

export async function readDataFile(file: File, opts: ImportOptions = {}): Promise<ImportResult> {
  const type = ext(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(type)) {
    throw new ImportError(`“${type || file.name}” files aren’t supported. Use CSV, Excel (.xlsx), JSON or Parquet.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ImportError(`This file is ${(file.size / 1048576).toFixed(0)} MB. Files up to ${MAX_FILE_BYTES / 1048576} MB can be opened in the browser.`);
  }
  if (type === '.xlsx') return readExcel(file, opts.sheet);
  if (type === '.parquet') return readParquet(file);
  const text = await file.text();
  if (type === '.json' || type === '.jsonl' || type === '.ndjson') return fromRecords(parseJsonRecords(text), file.name);
  return capRows(parseCSV(text, file.name, type === '.tsv' ? '\t' : undefined));
}

/** JSON array of objects, `{ "data": [...] }`-style wrappers, or one object per line. */
export function parseJsonRecords(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // JSON Lines: one object per line.
    try {
      value = trimmed.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    } catch {
      throw new ImportError('This isn’t valid JSON or JSON Lines.');
    }
  }
  if (value && !Array.isArray(value) && typeof value === 'object') {
    const arrays = Object.values(value as Record<string, unknown>).filter(Array.isArray) as unknown[][];
    if (arrays.length === 1) value = arrays[0];
  }
  if (!Array.isArray(value)) throw new ImportError('The JSON must be a list of records (objects), e.g. [{"a": 1}, {"a": 2}].');
  const records = value.filter(v => v && typeof v === 'object' && !Array.isArray(v)) as Record<string, unknown>[];
  if (records.length === 0) throw new ImportError('The JSON has no records (objects) to import.');
  return records.map(r => flatten(r));
}

/** Nested objects become dotted columns: {a: {b: 1}} -> {"a.b": 1}. */
function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && depth < 3) flatten(v as Record<string, unknown>, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

function fromRecords(records: Record<string, unknown>[], filename: string, notes: string[] = []): ImportResult {
  if (records.length === 0) throw new ImportError('The file has no data rows.');
  const keys: string[] = [];
  const seen = new Set<string>();
  records.forEach(r => Object.keys(r).forEach(k => { if (!seen.has(k)) { seen.add(k); keys.push(k); } }));
  const headers = uniqueHeaders(keys);
  const rows = records.slice(0, MAX_ROWS).map(r => {
    const row: Record<string, any> = {};
    keys.forEach((k, i) => { row[headers[i]] = r[k]; });
    return row;
  });
  if (records.length > MAX_ROWS) notes.push(`Only the first ${MAX_ROWS.toLocaleString()} of ${records.length.toLocaleString()} rows were loaded.`);
  return { dataset: datasetFromRecords(headers, rows, filename), notes };
}

function capRows(dataset: Dataset): ImportResult {
  if (dataset.rows.length <= MAX_ROWS) return { dataset, notes: [] };
  const total = dataset.rows.length;
  const rows = dataset.rows.slice(0, MAX_ROWS);
  const headers = dataset.columns.map(c => c.name);
  return {
    dataset: datasetFromRecords(headers, rows, dataset.filename),
    notes: [`Only the first ${MAX_ROWS.toLocaleString()} of ${total.toLocaleString()} rows were loaded.`],
  };
}

async function readExcel(file: File, sheet?: string): Promise<ImportResult> {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = (await readXlsxFile(file)) as { sheet: string; data: unknown[][] }[];
  } catch (err: any) {
    throw new ImportError(`Couldn’t read this Excel file: ${err?.message || err}. Only .xlsx is supported (save older .xls files as .xlsx).`);
  }
  if (sheets.length === 0) throw new ImportError('This Excel file has no sheets.');
  const chosen = sheets.find(s => s.sheet === sheet) ?? sheets[0];
  const data = chosen.data.filter(row => row.some(c => c !== null && c !== undefined && String(c).trim() !== ''));
  if (data.length < 2) throw new ImportError(`Sheet “${chosen.sheet}” needs a header row and at least one data row.`);
  const keys = data[0].map(c => String(c ?? ''));
  const records = data.slice(1).map(row => Object.fromEntries(keys.map((k, i) => [k || `column_${i + 1}`, row[i]])));
  const result = fromRecords(records, sheets.length > 1 ? `${file.name} (${chosen.sheet})` : file.name);
  return { ...result, sheets: sheets.map(s => s.sheet) };
}

async function readParquet(file: File): Promise<ImportResult> {
  const [{ parquetReadObjects }, { compressors }] = await Promise.all([import('hyparquet'), import('hyparquet-compressors')]);
  let records: Record<string, unknown>[];
  try {
    records = await parquetReadObjects({ file: await file.arrayBuffer(), compressors, rowEnd: MAX_ROWS + 1 });
  } catch (err: any) {
    throw new ImportError(`Couldn’t read this Parquet file: ${err?.message || err}`);
  }
  const notes: string[] = [];
  if (records.length > MAX_ROWS) {
    notes.push(`Only the first ${MAX_ROWS.toLocaleString()} rows were loaded.`);
    records = records.slice(0, MAX_ROWS);
  }
  return fromRecords(records.map(r => flatten(r)), file.name, notes);
}
