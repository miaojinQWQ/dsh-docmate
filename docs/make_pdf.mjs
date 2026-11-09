// Generate a small, valid, multi-page PDF with real (selectable) text.
// No dependencies: builds the objects, then writes a correct xref table.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const PAGES = [
  {
    title: 'DocMate Sample Report',
    lines: [
      'This PDF exists so the reader can be checked end to end:',
      'pdf.js must render the page, and the text layer must let a',
      'reader select a sentence with the mouse.',
      '',
      '1. Background',
      'A companion reading desk puts the document in the centre and',
      'the assistant on the right. The assistant only earns its place',
      'if it knows what the reader is looking at, which means the',
      'selection has to travel with the question.',
      '',
      '2. Method',
      'The panel keeps one ordinary Harness session alive. Every',
      'selection becomes one user message: the quoted passage first,',
      'then the question. Nothing else is invented.',
    ],
  },
  {
    title: 'Page two - layout checks',
    lines: [
      'Long lines wrap inside the page box, and the text layer keeps',
      'its spans aligned with the glyphs underneath.',
      '',
      '   - bullet one',
      '   - bullet two',
      '   - bullet three',
      '',
      'A second page also proves the lazy renderer mounts pages that',
      'start off-screen, and that the page counter stays honest.',
      '',
      'Numbers: 3.14159  2.71828  1.41421',
      'Mixed case: The Quick Brown Fox Jumps Over The Lazy Dog.',
    ],
  },
];

function escapeText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pageContent(page, index) {
  const parts = ['BT', '/F1 20 Tf', '56 780 Td', `(${escapeText(page.title)}) Tj`, '/F1 11 Tf', '0 -34 Td', '14 TL'];
  for (const line of page.lines) {
    parts.push(`(${escapeText(line)}) Tj`, 'T*');
  }
  parts.push('ET');
  parts.push('BT', '/F1 9 Tf', '56 40 Td', `(Page ${index + 1} of ${PAGES.length}) Tj`, 'ET');
  return parts.join('\n');
}

const objects = [];
function push(body) {
  objects.push(body);
  return objects.length; // 1-based object number
}

const catalogNo = push(null); // filled later
const pagesNo = push(null);
const fontNo = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

const pageRefs = [];
for (let i = 0; i < PAGES.length; i += 1) {
  const content = pageContent(PAGES[i], i);
  const contentNo = push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  const pageNo = push(
    `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${fontNo} 0 R >> >> /Contents ${contentNo} 0 R >>`,
  );
  pageRefs.push(pageNo);
}

objects[catalogNo - 1] = `<< /Type /Catalog /Pages ${pagesNo} 0 R >>`;
objects[pagesNo - 1] = `<< /Type /Pages /Kids [${pageRefs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;

let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
for (let i = 0; i < objects.length; i += 1) {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const out = path.join(here, 'sample-report.pdf');
writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log('wrote', out, Buffer.byteLength(pdf, 'latin1'), 'bytes');
