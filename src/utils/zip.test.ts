import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, createZip } from './zip';

describe('zip writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('produces an archive Python’s zipfile reads back exactly', () => {
    const zip = createZip([
      { path: 'README.md', data: '# Hello ✓' },
      { path: 'data/x.csv', data: 'a,b\n1,2\n' },
      { path: 'bin.dat', data: new Uint8Array([0, 255, 7]) },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const file = join(dir, 'out.zip');
    writeFileSync(file, zip);
    const out = execFileSync('python3', ['-I', '-c', [
      'import sys, zipfile, json',
      'z = zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'print(json.dumps({n: list(z.read(n)) if n.endswith(".dat") else z.read(n).decode() for n in z.namelist()}))',
    ].join('\n'), file]).toString();
    expect(JSON.parse(out)).toEqual({ 'README.md': '# Hello ✓', 'data/x.csv': 'a,b\n1,2\n', 'bin.dat': [0, 255, 7] });
  });
});
