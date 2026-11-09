/**
 * src/host/docx.test.mjs —— convertDocxToHtml 自测（零依赖，纯 node）
 *
 * 跑法：node src/host/docx.test.mjs
 *
 * 自己造 docx：手写最小 ZIP writer（CRC32 + deflateRawSync），
 * 样本 (a) 标题/粗斜体/段落/表格/列表/超链接/分页，
 * 样本 (b) word/media 里一张真的 1x1 PNG，
 * 样本 (c) 默认命名空间 + 缺 styles.xml 的降级路径。
 */

import { deflateRawSync, deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { convertDocxToHtml } from './docx.js';

/* ==========================================================================
 * 0. 迷你测试框架
 * ======================================================================== */

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${message}`);
  } else {
    failed++;
    console.error(`  \x1b[31m✗\x1b[0m ${message}`);
  }
}

function eq(actual, expected, message) {
  ok(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function throws(fn, pattern, message) {
  try {
    fn();
    ok(false, `${message} —— 但没有抛异常`);
  } catch (error) {
    ok(pattern.test(String(error && error.message)), `${message}：${error && error.message}`);
  }
}

function section(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`);
}

/* ==========================================================================
 * 1. 最小 ZIP writer
 * ======================================================================== */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * files: [{ name, data: string|Buffer, store?: boolean }]
 * 返回 zip 的 Buffer
 */
function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const store = !!file.store;
    const compressed = store ? data : deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    local.writeUInt16LE(store ? 0 : 8, 8); // method
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(store ? 0 : 8, 10); // method
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0x21, 14); // date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // 本地头偏移

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/* ==========================================================================
 * 2. 造一张真的 1x1 PNG（顺便复用 CRC32）
 * ======================================================================== */

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function makePng1x1(r = 255, g = 0, b = 0) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const rawScanline = Buffer.from([0, r, g, b]); // filter byte + RGB
  const idat = deflateSync(rawScanline);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ==========================================================================
 * 3. 样本 (a)：标题 + 粗体 + 斜体 + 段落 + 表格 + 列表 + 超链接 + 分页
 * ======================================================================== */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const SAMPLE_A_DOCUMENT = `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>第一章 概述</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">普通段落，含 </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>粗体</w:t></w:r>
      <w:r><w:t> 与 </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>斜体</w:t></w:r>
      <w:r><w:t>，以及 a &lt; b &amp;&amp; c &gt; d 这样的符号。</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>关闭粗体</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>下划线</w:t></w:r>
      <w:r><w:rPr><w:strike/></w:rPr><w:t>删除线</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>无序一</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>无序二</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>无序二-子项</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>
      <w:r><w:t>有序一</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>参考 </w:t></w:r>
      <w:hyperlink r:id="rIdLink"><w:r><w:t>示例站点</w:t></w:r></w:hyperlink>
      <w:r><w:t> 结束。</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tblPr/>
      <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>
        <w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>表头 A</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>表头 B</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>跨两列</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>纵向合并</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>右一</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
        <w:tc><w:p><w:r><w:t>右二</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p><w:r><w:t>分页后的段落</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

const SAMPLE_A_STYLES = `${XML_HEAD}<w:styles xmlns:w="${W_NS}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:b w:val="0"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/></w:rPr>
  </w:style>
</w:styles>`;

const SAMPLE_A_NUMBERING = `${XML_HEAD}<w:numbering xmlns:w="${W_NS}">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const SAMPLE_A_RELS = `${XML_HEAD}<Relationships xmlns="${REL_NS}">
  <Relationship Id="rIdLink" Type="${R_NS}/hyperlink" Target="https://example.com/a?x=1&amp;y=2" TargetMode="External"/>
</Relationships>`;

const SAMPLE_A_CORE = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>测试文档标题</dc:title>
</cp:coreProperties>`;

function buildSampleA() {
  return makeZip([
    // 故意用 stored（method 0）存一个条目，顺带验证直拷路径
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types/>`, store: true },
    { name: 'word/document.xml', data: SAMPLE_A_DOCUMENT },
    { name: 'word/styles.xml', data: SAMPLE_A_STYLES },
    { name: 'word/numbering.xml', data: SAMPLE_A_NUMBERING },
    { name: 'word/_rels/document.xml.rels', data: SAMPLE_A_RELS },
    { name: 'docProps/core.xml', data: SAMPLE_A_CORE },
  ]);
}

/* ==========================================================================
 * 4. 样本 (b)：word/media 里一张 1x1 PNG
 * ======================================================================== */

const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

const SAMPLE_B_DOCUMENT = `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}">
  <w:body>
    <w:p><w:r><w:t>下面是一张图片：</w:t></w:r></w:p>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline>
            <wp:extent cx="190500" cy="190500"/>
            <wp:docPr id="1" name="图片 1" descr="红色小方块"/>
            <a:graphic>
              <a:graphicData uri="${PIC_NS}">
                <pic:pic>
                  <pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
    <w:p><w:r><w:t>下面是一张缺失的图片：</w:t></w:r></w:p>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline>
            <wp:extent cx="95250" cy="95250"/>
            <wp:docPr id="2" name="图片 2"/>
            <a:graphic>
              <a:graphicData uri="${PIC_NS}">
                <pic:pic>
                  <pic:blipFill><a:blip r:embed="rIdMissing"/></pic:blipFill>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;

const SAMPLE_B_RELS = `${XML_HEAD}<Relationships xmlns="${REL_NS}">
  <Relationship Id="rIdImg" Type="${R_NS}/image" Target="media/image1.png"/>
</Relationships>`;

function buildSampleB() {
  return makeZip([
    { name: 'word/document.xml', data: SAMPLE_B_DOCUMENT },
    { name: 'word/_rels/document.xml.rels', data: SAMPLE_B_RELS },
    { name: 'word/media/image1.png', data: makePng1x1(255, 0, 0) },
  ]);
}

/* ==========================================================================
 * 5. 样本 (c)：默认命名空间 + 缺 styles.xml 的降级路径
 * ======================================================================== */

const SAMPLE_C_DOCUMENT = `${XML_HEAD}<document xmlns="${W_NS}" xmlns:w="${W_NS}">
  <body>
    <p><pPr><pStyle w:val="Heading2"/></pPr><r><t>默认命名空间标题</t></r></p>
    <p><r><t>正文 &lt;tag&gt; 与 &amp; 符号</t></r></p>
  </body>
</document>`;

function buildSampleC() {
  return makeZip([{ name: 'word/document.xml', data: SAMPLE_C_DOCUMENT }]);
}

/* ==========================================================================
 * 6. 跑测试
 * ======================================================================== */

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const VOID_ELEMENTS = new Set(['br', 'img', 'hr', 'col', 'input', 'meta', 'link', 'area', 'base', 'embed', 'source', 'track', 'wbr']);

/** 检查输出 HTML 的标签是否都正确闭合（空串 = 没问题） */
function htmlBalanceError(html) {
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = re.exec(html))) {
    const name = match[1].toLowerCase();
    if (VOID_ELEMENTS.has(name) || match[3] === '/') continue;
    if (html[match.index + 1] === '/') {
      const top = stack.pop();
      if (top !== name) return `</${name}> 与 <${top}> 不匹配`;
    } else {
      stack.push(name);
    }
  }
  return stack.length ? `未闭合：<${stack.join('>, <')}>` : '';
}

/* ---------- 样本 (a) ---------- */
section('样本 (a)：标题 / 粗体 / 斜体 / 段落 / 表格 / 列表 / 超链接 / 分页');
{
  const result = convertDocxToHtml(buildSampleA());
  const { html, title, warnings } = result;
  if (process.env.DUMP_DOCX_HTML) console.log(`\n--- sample A html ---\n${html}\n--- end ---\n`);

  ok(typeof html === 'string' && html.length > 0, '返回非空 html');
  ok(Array.isArray(warnings), 'warnings 是数组');
  eq(title, '测试文档标题', 'title 取自 docProps/core.xml');

  ok(!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html), '输出是片段（没有 <html>/<body> 外壳）');
  ok(html.startsWith('<div class="dm-docx-doc">'), '外层是 <div class="dm-docx-doc">');

  ok(html.includes('<h1>'), '标题输出 <h1>');
  ok(html.includes('第一章 概述'), '标题文本正确');
  ok(html.includes('<strong>粗体</strong>'), '粗体输出 <strong>');
  ok(html.includes('<em>斜体</em>'), '斜体输出 <em>');
  ok(html.includes('<u>下划线</u>'), '下划线输出 <u>');
  ok(html.includes('<s>删除线</s>'), '删除线输出 <s>');
  ok(!html.includes('<strong>关闭粗体</strong>'), 'w:b w:val="0" 被识别为关闭（不包 <strong>）');

  ok(html.includes('甲\t乙'), 'w:tab 输出制表符');
  ok(html.includes('乙<br>丙'), 'w:br 输出 <br>');

  ok(html.includes('a &lt; b &amp;&amp; c &gt; d'), '文本里的 < & > 全部转义');
  ok(!html.includes('a < b'), '文本里没有漏出未转义的 <');

  ok(html.includes('<ul>') && html.includes('</ul>'), 'bullet 列表输出 <ul>');
  ok(html.includes('<ol>') && html.includes('</ol>'), 'decimal 列表输出 <ol>');
  ok(html.includes('<li>无序一</li>'), '列表项输出 <li>');
  ok(html.includes('<li>无序二<ul><li>无序二-子项</li></ul></li>'), '子列表嵌套在 <li> 内部');

  ok(html.includes('<table class="dm-docx-table">'), '表格输出 <table class="dm-docx-table">');
  ok(html.includes('<tr>') && html.includes('<td>'), '表格输出 <tr>/<td>');
  ok(html.includes('<td>表头 A</td>'), '单元格文本正确');
  ok(html.includes('colspan="2"'), 'w:gridSpan 输出 colspan');
  ok(html.includes('rowspan="2"'), 'w:vMerge 折算成 rowspan');

  ok(
    html.includes('<a class="dm-docx-link" href="https://example.com/a?x=1&amp;y=2"'),
    '超链接输出 <a href>（URL 里的 & 已转义）',
  );
  ok(html.includes('>示例站点</a>'), '超链接文本正确');

  ok(html.includes('<hr class="dm-docx-pagebreak">'), '分页输出 <hr class="dm-docx-pagebreak">');
  ok(html.includes('<p>分页后的段落</p>'), '分页后的段落正常输出');

  ok(countOf(html, '<p></p>') === 0, '不输出空 <p></p>');
  eq(htmlBalanceError(html), '', '输出 HTML 的标签全部正确闭合');
  ok(warnings.length === 0, `没有意外 warning（实际：${JSON.stringify(warnings)}）`);
}

/* ---------- 样本 (b) ---------- */
section('样本 (b)：word/media 里的 1x1 PNG 内联成 data URI');
{
  const { html, title, warnings } = convertDocxToHtml(buildSampleB());

  ok(html.includes('<img class="dm-docx-img" src="data:image/png;base64,'), '图片输出 data:image/png;base64 URI');
  eq(countOf(html, '<img '), 1, '缺失的图片被跳过，只输出一张 <img>');
  ok(html.includes('alt="红色小方块"'), 'alt 取自 wp:docPr 的 descr');
  ok(html.includes('width="20"') && html.includes('height="20"'), '尺寸按 EMU 换算成 px（190500/9525 = 20）');

  const match = /src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(html);
  ok(!!match, '能取到 base64 载荷');
  if (match) {
    const png = Buffer.from(match[1], 'base64');
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    ok(png.slice(0, 8).equals(signature), 'base64 解出来是合法 PNG（签名正确）');
    ok(png.length > 8, `PNG 字节数 ${png.length} > 8`);
  }

  ok(
    warnings.some((w) => w.includes('rIdMissing')),
    `缺失图片记了 warning（实际：${JSON.stringify(warnings)}）`,
  );
  eq(title, '', '没有 core.xml / 标题时 title 为空串');
  eq(htmlBalanceError(html), '', '输出 HTML 的标签全部正确闭合');
}

/* ---------- 样本 (c) ---------- */
section('样本 (c)：默认命名空间 + 缺 styles.xml 的降级路径');
{
  const { html, warnings } = convertDocxToHtml(buildSampleC());

  ok(html.includes('<h2>'), '默认命名空间（xmlns="…/wordprocessingml/2006/main"）也能识别标题');
  ok(html.includes('默认命名空间标题'), '标题文本正确');
  ok(html.includes('正文 &lt;tag&gt; 与 &amp; 符号'), '默认命名空间下文本照常转义');
  ok(
    warnings.some((w) => w.includes('styles.xml')),
    `缺 styles.xml 时给出降级 warning（实际：${JSON.stringify(warnings)}）`,
  );
}

/* ---------- 健壮性 / 错误路径 ---------- */
section('健壮性 / 错误路径');
{
  throws(() => convertDocxToHtml(Buffer.from('这不是一个 zip 文件，只是一段普通文本。')), /不是有效的 \.docx/, '非 ZIP 输入抛可读错误');
  throws(() => convertDocxToHtml(new Uint8Array(0)), /文件太小/, '空输入抛可读错误');
  throws(
    () => convertDocxToHtml(makeZip([{ name: 'readme.txt', data: 'hello' }])),
    /word\/document\.xml/,
    '缺 word/document.xml 抛可读错误',
  );
  throws(() => convertDocxToHtml('不是字节数组'), /字节数组/, '非法入参抛可读错误');

  // OLE 复合文档（旧版 .doc / 加密 docx）给出可读提示
  const ole = Buffer.alloc(64);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole, 0);
  throws(() => convertDocxToHtml(ole), /OLE 复合文档|旧版 \.doc/, 'OLE 复合文档抛可读错误');

  // 坏图片（媒体文件存在但内容不是图片 / 扩展名不支持）只降级不抛
  const broken = makeZip([
    {
      name: 'word/document.xml',
      data: `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdEmf"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`,
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: `${XML_HEAD}<Relationships xmlns="${REL_NS}"><Relationship Id="rIdEmf" Type="${R_NS}/image" Target="media/image1.emf"/></Relationships>`,
    },
    { name: 'word/media/image1.emf', data: Buffer.from([1, 2, 3, 4]) },
  ]);
  let brokenResult = null;
  try {
    brokenResult = convertDocxToHtml(broken);
  } catch (error) {
    ok(false, `不支持的图片格式不应抛异常，实际抛了：${error && error.message}`);
  }
  if (brokenResult) {
    ok(!brokenResult.html.includes('<img'), '不支持的图片格式被跳过（不输出 <img>）');
    ok(
      brokenResult.warnings.some((w) => w.includes('不支持')),
      `不支持的图片格式记了 warning（实际：${JSON.stringify(brokenResult.warnings)}）`,
    );
  }

  // 缺 rels / numbering / styles 的最小文档也不能炸
  const minimal = makeZip([
    {
      name: 'word/document.xml',
      data: `${XML_HEAD}<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t>最小文档</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
  let minimalResult = null;
  try {
    minimalResult = convertDocxToHtml(minimal);
  } catch (error) {
    ok(false, `最小文档不应抛异常，实际抛了：${error && error.message}`);
  }
  if (minimalResult) {
    ok(minimalResult.html.includes('<p>最小文档</p>'), '只有 document.xml 也能正常渲染');
    // 缺的可选部件没有影响渲染时不应该刷 warning（只在真正降级时才提示）
    eq(minimalResult.warnings.length, 0, '未实际降级时不产生噪音 warning');
  }

  // 标题里夹分页符：内部占位符绝不能漏进输出
  const headingBreak = makeZip([
    {
      name: 'word/document.xml',
      data: `${XML_HEAD}<w:document xmlns:w="${W_NS}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题前</w:t><w:br w:type="page"/><w:t>标题后</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
  const hb = convertDocxToHtml(headingBreak);
  ok(!hb.html.includes('\u0000'), '标题里的分页占位符没有漏进输出');
  ok(hb.html.includes('<h1>'), '标题仍然输出 <h1>');
  ok(hb.html.includes('<hr class="dm-docx-pagebreak">'), '标题里的分页降级成标题后的 <hr>');
  eq(htmlBalanceError(hb.html), '', '该片段标签闭合');
}

/* ---------- 汇总 ---------- */
console.log('');
if (failed === 0) {
  console.log(`\x1b[32m全部通过：${passed} 项断言\x1b[0m`);
} else {
  console.error(`\x1b[31m失败 ${failed} 项 / 通过 ${passed} 项\x1b[0m`);
  process.exitCode = 1;
}
