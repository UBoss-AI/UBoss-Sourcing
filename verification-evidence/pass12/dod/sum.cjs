// Compact summary of a harness results.json: one line per page x width.
const r = require(require('path').resolve(process.argv[2])).results;
for (const x of r) {
  if (!x.page) { console.log(JSON.stringify(x)); continue; }
  const nf = (x.focus || []).filter((f) => /NO VISIBLE|^body$/.test(f));
  console.log(`${x.page}@${x.w} ${x.finalPath} h=${x.hScroll ? 'SCROLL ' + x.over.join('|') : 0} axe=${x.axe.map((a) => a.id + ':' + a.n + '(' + a.sample + ')').join(',') || 0} small=${x.smallTargets} js=${x.jsErrors.length}${x.focus ? ' focusBad=' + nf.length + (nf.length ? ' ' + nf.join('|') : '') : ''} h1=${x.h1.length}`);
}
