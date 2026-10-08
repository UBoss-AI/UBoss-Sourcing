const r = require(require('path').resolve(process.argv[2]));
for (const x of r.results) {
  if (x.page) console.log(x.page, x.w, 'hScroll=' + x.hScroll, 'axe=' + JSON.stringify(x.axe), 'js=' + x.jsErrors.length, '|', x.afterResult, x.focus ? '| focus=' + x.focus.join(' > ') : '');
  else console.log(JSON.stringify(x));
}
