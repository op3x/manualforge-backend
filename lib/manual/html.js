const fs = require('fs');
const path = require('path');
const { escapeHtml, cssString } = require('../text');

const CSS = fs.readFileSync(path.join(__dirname, '../../template/style.css'), 'utf8');

function badge(inferred) {
  return inferred ? ' <span class="inf">Inferred - please confirm</span>' : '';
}

function renderBlocks(blocks) {
  return blocks.map((block) => {
    if (block.type === 'p') return `<p>${escapeHtml(block.text)}${badge(block.inferred)}</p>`;
    if (block.type === 'note') return `<div class="note"><b>${escapeHtml(block.label || 'Note')}</b> ${escapeHtml(block.text)}</div>`;
    if (block.type === 'ul') return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    if (block.type === 'steps') {
      return `<ol class="steps">${block.items.map((item) => `<li>${escapeHtml(item.action)}${item.expect ? `<span class="expect"><b>Expected result. </b>${escapeHtml(item.expect)}</span>` : ''}${badge(item.inferred)}</li>`).join('')}</ol>`;
    }
    if (block.type === 'table') {
      const widths = (block.widths || []).map((width) => `<col style="width:${escapeHtml(width)}">`).join('');
      const klass = [block.small ? 'small' : '', block.className || '', block.allowIdentifiers ? 'xref' : ''].filter(Boolean).join(' ');
      const body = block.rows.map((row) => `<tr>${row.map((cell, index) => {
        const tag = block.allowIdentifiers && index === row.length - 1 ? ' class="tagcol"' : '';
        return `<td${tag}>${escapeHtml(cell)}</td>`;
      }).join('')}</tr>`).join('');
      return `<table class="${klass}">${widths ? `<colgroup>${widths}</colgroup>` : ''}<thead><tr>${block.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>${badge(block.inferred)}`;
    }
    if (block.type === 'hazard') {
      const hazard = block.hazard;
      const word = String(hazard.signal_word || 'WARNING').toLowerCase();
      const symbol = word === 'notice' ? '' : '<span class="alert">&#9888;</span>';
      return `<div class="hz hz-${escapeHtml(word)}"><div class="hzhead">${symbol}${escapeHtml(hazard.signal_word)}</div><div class="hzbody"><p class="hzt">${escapeHtml(hazard.hazard)}</p><p>${escapeHtml(hazard.consequence)}</p><ul>${(hazard.avoidance || []).map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ul></div></div>${badge(block.inferred)}`;
    }
    if (block.type === 'figure') {
      const callouts = (block.callouts || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
      return `<figure>${block.svg}<figcaption>${escapeHtml(block.caption)}${badge(block.inferred)}</figcaption></figure>${callouts ? `<ol class="callouts">${callouts}</ol>` : ''}`;
    }
    if (block.type === 'subhead' || block.type === 'group') {
      const ref = block.ref ? ` <span class="ref">${escapeHtml(block.ref)}</span>` : '';
      const body = block.text ? `<p>${escapeHtml(block.text)}${badge(block.inferred)}</p>` : '';
      return `<div class="lgroup"><h3>${escapeHtml(block.text && block.type === 'subhead' ? block.text : block.title || block.text)}${ref}</h3>${block.type === 'group' ? body : ''}</div>`;
    }
    return '';
  }).join('');
}

function renderHtml(doc) {
  const css = CSS
    .replaceAll('__HEADER_LEFT__', cssString(doc.meta.headerLeft))
    .replaceAll('__HEADER_RIGHT__', cssString(doc.meta.headerRight))
    .replaceAll('__FOOTER_LEFT__', cssString(doc.meta.footerLeft));
  const toc = doc.chapters.flatMap((chapter) => [
    `<li class="l1"><a href="#${chapter.id}"><span class="tn">${escapeHtml(chapter.number)}</span><span class="tt">${escapeHtml(chapter.title)}</span><span class="dots"></span><span class="tp"></span></a></li>`,
    ...chapter.sections.map((section) => `<li class="l2"><a href="#${section.anchor}"><span class="tn">${escapeHtml(section.number)}</span><span class="tt">${escapeHtml(section.title)}</span><span class="dots"></span><span class="tp"></span></a></li>`),
  ]).join('');
  const body = doc.chapters.map((chapter) => `<section class="chapter"><h1 id="${chapter.id}"><span class="num">${escapeHtml(chapter.number)}</span>${escapeHtml(chapter.title)}</h1>${
    chapter.sections.map((section) => `<h2 id="${section.anchor}"><span class="num">${escapeHtml(section.number)}</span>${escapeHtml(section.title)}</h2>${renderBlocks(section.blocks)}`).join('')
  }</section>`).join('');
  const cover = doc.cover;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(cover.title)} – Operating and Maintenance Manual</title><style>${css}</style></head><body>
<section class="cover"><div class="band"></div>
<div class="maker">${escapeHtml(cover.manufacturer)}</div>
<h1 class="ctitle">${escapeHtml(cover.title)}</h1>
<div class="csub">Operating and Maintenance Manual</div>
${cover.svg ? `<div class="cimg">${cover.svg}</div>` : ''}
<table class="cmeta"><tr><td>Model</td><td>${escapeHtml(cover.model)}</td></tr>
<tr><td>Serial number</td><td>${escapeHtml(cover.serial)}</td></tr>
<tr><td>Document</td><td>${escapeHtml(cover.docNumber)}</td></tr>
<tr><td>Revision</td><td>${escapeHtml(cover.revision)} · ${escapeHtml(cover.date)}</td></tr>
<tr><td>Language</td><td>${escapeHtml(cover.language)}</td></tr></table>
<div class="cwarn">&#9888; Read and understand this manual before installing, operating, or servicing the machine. Keep it with the machine.</div>
<div class="cfoot">Generated from engineering files. The manufacturer must review every inferred statement before this manual is issued.</div>
</section>
<section class="toc"><h1 class="tochead">Contents</h1><ul>${toc}</ul></section>
<main>${body}</main></body></html>`;
}

function headingsIn(html) {
  const headings = [];
  for (const match of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    headings.push(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return headings;
}

module.exports = { renderHtml, headingsIn };
