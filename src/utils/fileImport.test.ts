import { describe, expect, it } from 'vitest';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { ImportError, parseJsonRecords, readDataFile } from './fileImport';
import { detectDelimiter, parseCSV } from './csvParser';

const file = (name: string, content: BlobPart) => new File([content], name);

describe('file import', () => {
  it('detects semicolon and tab delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('"a;x",b\n1,2')).toBe(',');
    const ds = parseCSV('name;score\nAna;3,5\nBo;4', 'x.csv');
    expect(ds.columns.map(c => c.name)).toEqual(['name', 'score']);
  });

  it('reads JSON arrays, wrapped arrays and JSON Lines, flattening nested objects', () => {
    expect(parseJsonRecords('[{"a":1,"b":{"c":2}}]')).toEqual([{ a: 1, 'b.c': 2 }]);
    expect(parseJsonRecords('{"data":[{"a":1}],"meta":{"n":1}}')).toEqual([{ a: 1 }]);
    expect(parseJsonRecords('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseJsonRecords('[1,2]')).toThrow(ImportError);
  });

  it('builds typed columns from JSON, with missing keys as empty', async () => {
    const { dataset } = await readDataFile(file('d.json', '[{"id":1,"ok":true,"city":"Rome"},{"id":2,"ok":false}]'));
    expect(dataset.columns.map(c => [c.name, c.type])).toEqual([['id', 'numeric'], ['ok', 'boolean'], ['city', 'categorical']]);
    expect(dataset.rows[1].city).toBeNull();
    expect(dataset.columns.find(c => c.name === 'city')!.missingCount).toBe(1);
  });

  it('reads Parquet', async () => {
    const buf = parquetWriteBuffer({
      columnData: [
        { name: 'name', data: ['Ana', 'Bo', 'Cy'], type: 'STRING' },
        { name: 'age', data: [31, null, 45], type: 'INT32' },
        { name: 'big', data: [1n, 2n, 3n], type: 'INT64' },
      ],
    });
    const { dataset } = await readDataFile(file('p.parquet', buf));
    expect(dataset.rows).toEqual([
      { name: 'Ana', age: 31, big: 1 },
      { name: 'Bo', age: null, big: 2 },
      { name: 'Cy', age: 45, big: 3 },
    ]);
    expect(dataset.columns.find(c => c.name === 'age')!.statistics.mean).toBe(38);
  });

  it('rejects unsupported types', async () => {
    await expect(readDataFile(file('x.xls', 'abc'))).rejects.toThrow('aren’t supported');
  });

  it('keeps null distinct from the number 0 when typing columns', () => {
    const ds = parseCSV('a,b\n1,x\n,y\n3,z', 't.csv');
    expect(ds.columns[0].type).toBe('numeric');
    expect(ds.rows[1].a).toBeNull();
    expect(ds.columns[0].missingCount).toBe(1);
  });
});
