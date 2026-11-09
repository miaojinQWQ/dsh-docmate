// Ad-hoc check: convert the real python-docx fixture and summarise the output.
import { readFile } from 'node:fs/promises';
import { convertDocxToHtml } from '../src/host/docx.js';

const bytes = new Uint8Array(await readFile(new URL('./课程大纲.docx', import.meta.url)));
const result = convertDocxToHtml(bytes);

console.log('title:', JSON.stringify(result.title));
console.log('warnings:', JSON.stringify(result.warnings));
console.log('html length:', result.html.length);

const histogram = {};
for (const match of result.html.matchAll(/<([a-z0-9]+)[ >]/g)) {
  histogram[match[1]] = (histogram[match[1]] || 0) + 1;
}
console.log('tag histogram:', JSON.stringify(histogram));

const image = result.html.match(/<img[^>]*src="data:image\/([a-z]+);base64,([^"]{0,32})/);
console.log('image:', image ? image[1] + ' head=' + image[2] : 'NONE');

const text = result.html.replace(/<[^>]+>/g, '');
console.log('text sample:', JSON.stringify(text.slice(0, 200)));

console.log('--- first 1200 chars of html ---');
console.log(result.html.slice(0, 1200));
