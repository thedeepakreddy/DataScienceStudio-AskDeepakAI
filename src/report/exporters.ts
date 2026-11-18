/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { jsPDF } from 'jspdf';
import { toPng } from 'html-to-image';
import type { Block } from './buildReport';
import type { ReportLayout, shapeReport } from './layout';

type Shaped = ReturnType<typeof shapeReport>['sections'];

/** A picture of a chart or result panel, as shown on the page. */
export interface Visual { data: string; width: number; height: number }

/**
 * Pictures of every chart and result panel in the report (elements marked
 * `data-report-visual`), drawn by the browser itself so every style is kept,
 * at twice the screen resolution, on white. Panels that can't be drawn are left out.
 */
export async function captureVisuals(root: HTMLElement, onProgress?: (done: number, total: number) => void): Promise<Map<string, Visual>> {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-report-visual]'));
  const out = new Map<string, Visual>();
  // Light colours for the capture, even when the studio is dark.
  const html = document.documentElement;
  const theme = html.getAttribute('data-theme');
  html.setAttribute('data-theme', 'light');
  try {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      onProgress?.(i, nodes.length);
      const { width, height } = el.getBoundingClientRect();
      if (width < 4 || height < 4) continue;
      try {
        const data = await toPng(el, {
          pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true,
          filter: n => !(n instanceof HTMLElement && (n.classList.contains('report-edit-only') || n.tagName === 'BUTTON')),
        });
        out.set(el.dataset.reportVisual!, { data, width, height });
      } catch { /* that panel stays as text and numbers */ }
    }
    onProgress?.(nodes.length, nodes.length);
  } finally {
    if (theme === null) html.removeAttribute('data-theme'); else html.setAttribute('data-theme', theme);
  }
  return out;
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The page exactly as shown (charts included) as one self-contained HTML file. */
export function toHtml(el: HTMLElement, title: string): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.report-edit-only').forEach(n => n.remove());
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try { css += Array.from(sheet.cssRules).map(r => r.cssText).join('\n'); } catch { /* a stylesheet from another origin */ }
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${css}\nbody{background:#f5f5f7;padding:24px 12px}</style></head><body>${clone.outerHTML}</body></html>`;
}

/** A clean A4 PDF of the report: headings, text, key figures, tables and code (charts as their numbers). */
export function toPdf(sections: Shaped, layout: ReportLayout, datasetName: string, generatedAt: number, visuals: Map<string, Visual> = new Map()): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const L = 18, W = 174, BOTTOM = 282;
  let y = 24;
  const room = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); y = 20; } };
  const text = (t: string, o: { size?: number; bold?: boolean; color?: [number, number, number]; indent?: number; mono?: boolean; gap?: number } = {}) => {
    doc.setFont(o.mono ? 'courier' : 'helvetica', o.bold ? 'bold' : 'normal');
    doc.setFontSize(o.size ?? 10);
    doc.setTextColor(...(o.color ?? [40, 40, 45]));
    const lines = doc.splitTextToSize(t, W - (o.indent ?? 0)) as string[];
    const lh = (o.size ?? 10) * 0.45;
    for (const line of lines) { room(lh + 1); doc.text(line, L + (o.indent ?? 0), y); y += lh; }
    y += o.gap ?? 1.5;
  };
  const table = (columns: { key: string; label: string }[], rows: Record<string, unknown>[], caption?: string) => {
    if (caption) text(caption, { bold: true, size: 9.5 });
    const cw = W / columns.length;
    const row = (cells: string[], bold: boolean) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8);
      const wrapped = cells.map(c => doc.splitTextToSize(c, cw - 2) as string[]);
      const h = Math.max(...wrapped.map(w => w.length)) * 3.6 + 1.5;
      room(h);
      if (bold) { doc.setFillColor(245, 245, 247); doc.rect(L, y - 3.2, W, h, 'F'); }
      doc.setTextColor(40, 40, 45);
      wrapped.forEach((w, i) => doc.text(w, L + i * cw + 1, y));
      y += h;
      doc.setDrawColor(225, 225, 230); doc.line(L, y - 3.4, L + W, y - 3.4);
    };
    row(columns.map(c => c.label), true);
    rows.slice(0, 60).forEach(r => row(columns.map(c => String(r[c.key] ?? '—')), false));
    if (rows.length > 60) text(`… ${rows.length - 60} more rows in the HTML export.`, { size: 8, color: [110, 110, 115] });
    y += 2;
  };
  // A captured picture, scaled to the page width (or down to fit a page), split over pages when taller.
  const image = (v: Visual) => {
    const w = Math.min(W, v.width * 0.2646); // px → mm at 96 dpi, never wider than the text
    const h = (v.height / v.width) * w;
    const pageRoom = BOTTOM - 20;
    if (h <= pageRoom) {
      room(h + 2);
      doc.addImage(v.data, 'PNG', L, y - 3, w, h, undefined, 'FAST');
      y += h + 3;
      return;
    }
    // Taller than a page: cut it into page-high slices.
    const img = new Image();
    img.src = v.data;
    const pxPerMm = (v.height * 2) / h;
    let done = 0;
    while (done < h) {
      if (y > 30) { doc.addPage(); y = 20; }
      const slice = Math.min(pageRoom, h - done);
      const canvas = document.createElement('canvas');
      canvas.width = v.width * 2; canvas.height = Math.ceil(slice * pxPerMm);
      const ctx = canvas.getContext('2d');
      if (!ctx || !img.complete) { doc.addImage(v.data, 'PNG', L, y - 3, w, h, undefined, 'FAST'); y += h; return; }
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, -done * pxPerMm);
      doc.addImage(canvas.toDataURL('image/png'), 'PNG', L, y - 3, w, slice, undefined, 'FAST');
      y += slice + 2;
      done += slice;
    }
  };
  const appendix: { caption: string; columns: { key: string; label: string }[]; rows: Record<string, unknown>[] }[] = [];
  const figure = (b: Extract<Block, { kind: 'bars' | 'histogram' | 'heatmap' }>, n: number) => {
    const v = visuals.get(b.id);
    // Keep the caption on the same page as its picture.
    if (v) { const w = Math.min(W, v.width * 0.2646); const h = (v.height / v.width) * w; if (h <= BOTTOM - 20) room(h + 9); }
    text(`Figure ${n}. ${b.caption}`, { bold: true, size: 9.5 });
    if (!v) return false;
    image(v);
    const rows = b.kind === 'heatmap'
      ? b.columns.map((c, i) => ({ c, ...Object.fromEntries(b.matrix[i].map((x, j) => [`m${j}`, x == null ? '—' : x.toFixed(2)])) }))
      : b.data.map(d => ({ ...d, value: Number(d.value.toPrecision(4)) }));
    const columns = b.kind === 'heatmap' ? [{ key: 'c', label: '' }, ...b.columns.map((c, j) => ({ key: `m${j}`, label: c }))]
      : [{ key: 'label', label: b.kind === 'histogram' ? 'From' : 'Value' }, { key: 'value', label: b.kind === 'histogram' ? 'Rows' : 'Score' }];
    appendix.push({ caption: `Figure ${n}. ${b.caption}`, columns, rows });
    return true;
  };
  let figN = 0;
  const block = (b: Block) => {
    if ((b.kind === 'bars' || b.kind === 'histogram' || b.kind === 'heatmap') && figure(b, ++figN)) return;
    switch (b.kind) {
      case 'paragraph': text(b.text); break;
      case 'bullets': if (b.title) text(b.title, { bold: true, size: 9.5 }); b.items.forEach(x => text(`•  ${x}`, { indent: 2, gap: 0.6 })); y += 1.5; break;
      case 'stats': table([{ key: 'k', label: 'Measure' }, { key: 'v', label: 'Value' }], b.items.map(([k, v]) => ({ k, v }))); break;
      case 'table': table(b.columns, b.rows, b.caption); break;
      case 'bars': case 'histogram': table([{ key: 'label', label: b.kind === 'histogram' ? 'From' : 'Value' }, { key: 'value', label: b.kind === 'histogram' ? 'Rows' : 'Score' }], b.data.map(d => ({ ...d, value: Number(d.value.toPrecision(4)) }))); break;
      case 'heatmap': table([{ key: 'c', label: '' }, ...b.columns.map((c, j) => ({ key: `m${j}`, label: c }))], b.columns.map((c, i) => ({ c, ...Object.fromEntries(b.matrix[i].map((v, j) => [`m${j}`, v == null ? '—' : v.toFixed(2)])) }))); break;
      case 'code': text(b.caption, { bold: true, size: 9.5 }); text(b.code, { mono: true, size: 7.5, color: [30, 30, 35], gap: 3 }); break;
      case 'callout': text(`${b.title ? `${b.title}: ` : ''}${b.text}`, { size: 9.5, color: b.tone === 'warn' ? [168, 72, 0] : [80, 80, 85] }); break;
      case 'analysis': {
        const v = visuals.get(b.id);
        if (v) { const w = Math.min(W, v.width * 0.2646); const h = (v.height / v.width) * w; if (h <= BOTTOM - 40) room(h + 22); }
        text(b.title, { bold: true, size: 10.5, gap: 0.5 });
        text(`${new Date(b.when).toLocaleString()}${b.capability ? ` · ${b.capability}` : ''}${b.runId ? ` · run ${b.runId}` : ''}`, { size: 8, color: [110, 110, 115], gap: 0.8 });
        text(b.headline, { gap: 0.8 });
        b.lines.forEach(l => text(`•  ${l}`, { indent: 2, size: 9, gap: 0.5 }));
        if (v) image(v);
        y += 2;
        break;
      }
    }
  };

  // Cover
  text((layout.organisation || 'Data Science Studio').toUpperCase(), { size: 8, color: [110, 110, 115], gap: 6 });
  text(layout.title || 'Data Analysis Report', { size: 22, bold: true, color: [29, 29, 31] });
  if (layout.subtitle) text(layout.subtitle, { size: 12, color: [80, 80, 85] });
  text(`Dataset: ${datasetName}   ·   Prepared by: ${layout.author || '—'}   ·   ${new Date(generatedAt).toLocaleDateString(undefined, { dateStyle: 'long' })}`, { size: 9, color: [110, 110, 115], gap: 3 });
  doc.setDrawColor(29, 29, 31); doc.setLineWidth(0.6); doc.line(L, y, L + W, y); doc.setLineWidth(0.2); y += 6;
  if (layout.showContents) { text('Contents', { bold: true, size: 11 }); sections.forEach((s, i) => text(`${i + 1}.  ${s.title}`, { indent: 2, gap: 0.4 })); y += 4; }

  sections.forEach((s, i) => {
    if (i > 0) { doc.addPage(); y = 20; }
    text(`${i + 1}. ${s.title}`, { size: 15, bold: true, color: [29, 29, 31], gap: 1 });
    text(s.intro, { size: 9.5, color: [110, 110, 115], gap: 3 });
    if (s.note.trim()) text(s.note.trim(), { gap: 3 });
    s.blocks.forEach(block);
  });
  if (appendix.length) {
    doc.addPage(); y = 20;
    text('Appendix: the numbers behind the figures', { size: 15, bold: true, color: [29, 29, 31], gap: 3 });
    appendix.forEach(a => table(a.columns, a.rows, a.caption));
  }
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(140, 140, 145);
    doc.text(`${layout.title || 'Data Analysis Report'} · ${datasetName}`, L, 292);
    doc.text(`Page ${p} of ${pages}`, L + W, 292, { align: 'right' });
  }
  return doc;
}

/** Opens the browser's print dialog for the report only (Save as PDF keeps the charts). */
export function printReport() {
  document.body.classList.add('printing-report');
  const done = () => { document.body.classList.remove('printing-report'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
}
