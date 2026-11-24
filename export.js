/* Exports Excel (.xlsx) et PDF générés dans le navigateur, sans bibliothèque, donc utilisables hors connexion. */
(function (root) {
  'use strict';
  const enc = new TextEncoder();
  const u8 = s => enc.encode(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

  /* ---------- ZIP (sans compression) ---------- */
  const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    const parts = [], central = []; let offset = 0;
    const w16 = (a, v) => a.push(v & 255, (v >>> 8) & 255), w32 = (a, v) => { w16(a, v & 0xFFFF); w16(a, v >>> 16); };
    files.forEach(f => {
      const name = u8(f.name), data = f.data, crc = crc32(data), h = [];
      w32(h, 0x04034b50); w16(h, 20); w16(h, 0x0800); w16(h, 0); w16(h, 0); w16(h, 0x21); w32(h, crc); w32(h, data.length); w32(h, data.length); w16(h, name.length); w16(h, 0);
      parts.push(new Uint8Array(h), name, data);
      const c = [];
      w32(c, 0x02014b50); w16(c, 20); w16(c, 20); w16(c, 0x0800); w16(c, 0); w16(c, 0); w16(c, 0x21); w32(c, crc); w32(c, data.length); w32(c, data.length);
      w16(c, name.length); w16(c, 0); w16(c, 0); w16(c, 0); w16(c, 0); w32(c, 0); w32(c, offset);
      central.push(new Uint8Array(c), name);
      offset += h.length + name.length + data.length;
    });
    let csize = 0; central.forEach(p => csize += p.length);
    const end = []; w32(end, 0x06054b50); w16(end, 0); w16(end, 0); w16(end, files.length); w16(end, files.length); w32(end, csize); w32(end, offset); w16(end, 0);
    const all = parts.concat(central, [new Uint8Array(end)]); let total = 0; all.forEach(p => total += p.length);
    const out = new Uint8Array(total); let o = 0; all.forEach(p => { out.set(p, o); o += p.length; }); return out;
  }

  /* ---------- XLSX ---------- */
  const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  function xlsx(sheets) {
    const safe = (n, i) => (String(n).replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31) || 'Feuille' + (i + 1));
    const files = [
      { name: '[Content_Types].xml', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>') },
      { name: '_rels/.rels', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + esc(safe(s.name, i)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
      { name: 'xl/styles.xml', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDE6F0"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>') },
    ];
    sheets.forEach((s, i) => {
      const widths = [];
      s.rows.forEach(r => r.forEach((v, c) => { widths[c] = Math.min(60, Math.max(widths[c] || 8, String(v == null ? '' : v).length + 2)); }));
      const rowsXml = s.rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, c) => {
        if (v == null || v === '') return '';
        const ref = colName(c) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
        return typeof v === 'number' ? '<c r="' + ref + '"' + st + '><v>' + v + '</v></c>' : '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
      }).join('') + '</row>').join('');
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: u8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' + widths.map((w, c) => '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols><sheetData>' + rowsXml + '</sheetData></worksheet>') });
    });
    return zip(files);
  }

  /* ---------- PDF (A4 paysage, Helvetica, texte WinAnsi) ---------- */
  function pdf(doc) {
    const W = 842, H = 595, M = 36, FS = 8.5, LH = 12;
    const latin = s => { let o = ''; s = String(s == null ? '' : s); for (const ch of s) { const c = ch.codePointAt(0); o += c < 256 ? ch : (ch === '’' ? "'" : ch === '–' || ch === '—' ? '-' : ch === '›' ? '>' : ch === '…' ? '...' : '?'); } return o; };
    const pdfStr = s => '(' + latin(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ') + ')';
    const fit = (s, w, fs) => { s = latin(s); const max = Math.max(1, Math.floor(w / (fs * 0.5))); return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '.' : s; };
    const pages = []; let ops, y;
    const newPage = () => { ops = []; y = H - M; pages.push(ops); };
    const text = (x, yy, s, fs, bold) => ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + fs + ' Tf ' + x.toFixed(1) + ' ' + yy.toFixed(1) + ' Td ' + pdfStr(s) + ' Tj ET');
    const ensure = h => { if (y - h < M + 14) newPage(); };
    newPage();
    text(M, y - 14, doc.title, 16, true); y -= 24;
    (doc.lines || []).forEach(l => { text(M, y - 10, l, 9.5, false); y -= 13; });
    y -= 6;
    (doc.sections || []).forEach(sec => {
      ensure(60); text(M, y - 11, sec.heading, 12, true); y -= 20;
      if (sec.note) { text(M, y - 9, sec.note, 8.5, false); y -= 13; }
      const total = sec.cols.reduce((a, c) => a + c.w, 0), k = (W - 2 * M) / total, cols = sec.cols.map(c => ({ h: c.h, w: c.w * k }));
      const header = () => { ops.push('0.87 0.9 0.94 rg ' + M + ' ' + (y - LH + 2) + ' ' + (W - 2 * M) + ' ' + LH + ' re f 0 g'); let x = M; cols.forEach(c => { text(x + 2, y - 8, fit(c.h, c.w - 4, FS), FS, true); x += c.w; }); y -= LH; };
      if (!sec.rows.length) { text(M, y - 9, 'Aucune donnée.', FS, false); y -= 16; return; }
      ensure(LH * 3); header();
      sec.rows.forEach((r, ri) => {
        if (y - LH < M + 14) { newPage(); header(); }
        if (ri % 2) ops.push('0.96 0.96 0.96 rg ' + M + ' ' + (y - LH + 2) + ' ' + (W - 2 * M) + ' ' + LH + ' re f 0 g');
        let x = M; r.forEach((v, ci) => { text(x + 2, y - 8, fit(v, cols[ci].w - 4, FS), FS, false); x += cols[ci].w; }); y -= LH;
      });
      y -= 12;
    });
    pages.forEach((p, i) => p.push('BT /F1 8 Tf ' + (W - M - 70) + ' ' + (M - 14) + ' Td ' + pdfStr('Page ' + (i + 1) + ' / ' + pages.length) + ' Tj ET'));
    const objs = []; const add = s => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>'); add(''); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    pages.forEach(p => {
      const body = p.join('\n'); const cid = add('<< /Length ' + body.length + ' >>\nstream\n' + body + '\nendstream');
      kids.push(add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + cid + ' 0 R >>') + ' 0 R');
    });
    objs[1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>';
    let out = '%PDF-1.4\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const xref = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    const bytes = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
    return bytes;
  }

  const api = { xlsx, pdf, zip, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Exporter = api;
})(typeof self !== 'undefined' ? self : this);
