const {execFileSync}=require('child_process');const fs=require('fs');
const show=(st,p)=>{try{return JSON.parse(execFileSync('git',['show',`:${st}:${p}`],{encoding:'utf8',maxBuffer:1e8}))}catch{return {}}};
function merge(o,t,b){const r={...o};for(const k of Object.keys(t)){if(!(k in o))r[k]=t[k];else if(typeof o[k]==='object'&&typeof t[k]==='object'&&o[k]&&t[k])r[k]=merge(o[k],t[k],(b&&b[k])||{});else if(JSON.stringify(o[k])!==JSON.stringify(t[k])&&b&&JSON.stringify(o[k])===JSON.stringify(b[k]))r[k]=t[k];}return r;}
for(const p of process.argv.slice(2)){const eol=execFileSync('git',['show',`:2:${p}`],{encoding:'utf8',maxBuffer:1e8}).includes('\r\n')?'\r\n':'\n';
fs.writeFileSync(p,JSON.stringify(merge(show(2,p),show(3,p),show(1,p)),null,2).replace(/\n/g,eol)+eol);}
