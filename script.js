/* ===================== Conferência de Arquivos: núcleo e leitura de arquivos ===================== */
(function(){
"use strict";

function $(sel, root){return (root||document).querySelector(sel);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function uid(){return 'id'+Math.random().toString(36).slice(2,10);}

var TYPE_DEFS = [
  {id:'presenca', icon:'✅', title:'Conferência de Bases', desc:'Identifica registros correspondentes, ausentes ou divergentes entre duas bases.'},
  {id:'diferenca', icon:'🔁', title:'Comparação entre Versões', desc:'Identifica registros incluídos, removidos ou modificados entre um arquivo original e sua versão atualizada.'}
];
function typeDef(id){ for(var i=0;i<TYPE_DEFS.length;i++){ if(TYPE_DEFS[i].id===id) return TYPE_DEFS[i]; } return null; }
var THRESHOLDS = [100,90,80,70,60,50];

/* ---------- estado ---------- */
var STATE = {tabs:[], activeId:null, seq:0};

function makeSlot(key){ return {key:key, files:[], headers:[], rows:[], mode:'table', manual:false}; }

function newTab(){
  STATE.seq++;
  var t = {
    id: uid(), seq: STATE.seq, name: 'Conferência '+STATE.seq, type: null,
    slots: {a: makeSlot('a'), b: makeSlot('b')},
    threshold: 100,
    normOpts: {onlyAlnum:true, stripZeros:false},
    keyColsA: [], keyColsB: [], nameColA:'', nameColB:'',
    result: null, error: null
  };
  STATE.tabs.push(t);
  STATE.activeId = t.id;
  return t;
}
function getTab(id){ for(var i=0;i<STATE.tabs.length;i++){ if(STATE.tabs[i].id===id) return STATE.tabs[i]; } return null; }
function activeTab(){ return getTab(STATE.activeId); }
function closeTab(id){
  var idx = STATE.tabs.findIndex(function(t){return t.id===id;});
  if(idx<0) return;
  STATE.tabs.splice(idx,1);
  if(STATE.tabs.length===0){ newTab(); }
  else if(STATE.activeId===id){ STATE.activeId = STATE.tabs[Math.max(0,idx-1)].id; }
}

/* ---------- utilitários de texto ---------- */
function stripAccents(s){ return String(s==null?'':s).normalize('NFD').replace(/[̀-ͯ]/g,''); }
function normalizeVal(v, opts){
  opts = opts||{};
  var s = stripAccents(v).trim().toLowerCase();
  if(opts.onlyAlnum){ s = s.replace(/[^a-z0-9]/g,''); }
  if(opts.stripZeros){ s = s.replace(/^0+(?=\d)/,''); }
  return s;
}
function isBlank(v){ return v==null || String(v).trim()===''; }
function compositeKey(row, cols, opts){
  return cols.map(function(c){ return normalizeVal(row[c], opts); }).join('␟');
}
function headerBase(h){ return stripAccents(h).toLowerCase().replace(/\s*\(\d+\)\s*$/,'').trim(); }
var NAME_RE = /nome|colaborador|funcionario|empregado|servidor|pessoa/;

function colLetter(i){
  var s=''; i++;
  while(i>0){ var m=(i-1)%26; s=String.fromCharCode(65+m)+s; i=Math.floor((i-1)/26); }
  return s;
}
function parseCell(str){
  var m = /^\s*([A-Za-z]{1,3})\s*(\d{1,6})\s*$/.exec(str||'');
  if(!m) return null;
  var letters = m[1].toUpperCase(), n = 0;
  for(var i=0;i<letters.length;i++){ n = n*26 + (letters.charCodeAt(i)-64); }
  return {col:n-1, row:parseInt(m[2],10)-1};
}

/* ---------- monta a tabela a partir de uma grade (linhas x colunas) ----------
   Ignora linhas e colunas em branco. Se houver célula inicial (ex: A5), o cabeçalho
   é a linha indicada e a leitura começa na coluna indicada. */
function buildTable(aoa, startCellStr){
  var start = parseCell(startCellStr);
  var rows = (aoa||[]).map(function(r, i){
    return {n:i+1, cells:(r||[]).map(function(v){ return v==null?'':String(v).trim(); })};
  });
  var offset = 0;
  if(start){
    offset = start.col;
    rows = rows.filter(function(r){ return r.n >= start.row+1; }).map(function(r){ return {n:r.n, cells:r.cells.slice(start.col)}; });
  }
  rows = rows.filter(function(r){ return r.cells.some(function(c){ return c!==''; }); });
  if(!rows.length) return {headers:[], rows:[], letters:[], rowNums:[], headerRowNum:null};
  function cnt(r){ return r.cells.filter(function(c){ return c!==''; }).length; }
  var maxCount = Math.max.apply(null, rows.map(cnt));
  var need = Math.min(2, maxCount);
  var hIdx = 0;
  if(!start){ for(var i=0;i<rows.length;i++){ if(cnt(rows[i])>=need){ hIdx = i; break; } } }
  var headerRow = rows[hIdx];
  var data = rows.slice(hIdx+1);
  var width = headerRow.cells.length;
  data.forEach(function(r){ if(r.cells.length>width) width=r.cells.length; });
  var keep = [];
  for(var j=0;j<width;j++){
    var has = (headerRow.cells[j]||'')!=='';
    if(!has){ for(var k=0;k<data.length;k++){ if((data[k].cells[j]||'')!==''){ has=true; break; } } }
    if(has) keep.push(j);
  }
  var used = {}, headers = [], letters = [];
  keep.forEach(function(j){
    var name = headerRow.cells[j] || ('Coluna '+colLetter(offset+j));
    if(used[name]){ used[name]++; name = name+' ('+used[name]+')'; } else { used[name]=1; }
    headers.push(name); letters.push(colLetter(offset+j));
  });
  var outRows = [], rowNums = [];
  data.forEach(function(r){
    var o = {};
    keep.forEach(function(j, idx){ o[headers[idx]] = r.cells[j]||''; });
    outRows.push(o); rowNums.push(r.n);
  });
  return {headers:headers, rows:outRows, letters:letters, rowNums:rowNums, headerRowNum:headerRow.n};
}

/* ---------- padrão "Matrícula + Nome" (uma ou duas colunas lado a lado) ---------- */
function pairsFromTable(table){
  var heads = table.headers;
  var matIdx = [];
  heads.forEach(function(h, i){ if(/^matric/.test(headerBase(h))) matIdx.push(i); });
  if(!matIdx.length) return null;
  var blocks = matIdx.map(function(mi, bi){
    var limit = bi+1<matIdx.length ? matIdx[bi+1] : heads.length;
    var ni = -1;
    for(var j=mi+1;j<limit;j++){ if(NAME_RE.test(headerBase(heads[j]))){ ni=j; break; } }
    return {mat:heads[mi], nome: ni>=0 ? heads[ni] : null};
  });
  var out = [];
  table.rows.forEach(function(r){
    blocks.forEach(function(b){
      var m = r[b.mat];
      if(!isBlank(m)) out.push({'Matrícula':String(m).trim(), 'Nome': b.nome ? String(r[b.nome]||'').trim() : ''});
    });
  });
  return out;
}

var PDF_PAIR_RE = /(?:^|\s)(\d{1,3})\s+(\d{4,})\s+(.+?)(?=\s+\d{1,3}\s+\d{4,}\s|\s*$)/g;
function pairsFromPdfLines(lines){
  var out = [];
  lines.forEach(function(line){
    var re = new RegExp(PDF_PAIR_RE.source, 'g'), m;
    while((m = re.exec(line)) !== null){
      out.push({'Matrícula': m[2], 'Nome': m[3].trim()});
    }
  });
  return out;
}

function declaredCount(texts){
  for(var i=0;i<texts.length;i++){
    var m = /estiveram\s+presentes\s+(\d+)/i.exec(texts[i]);
    if(m) return parseInt(m[1],10);
  }
  return null;
}

/* ---------- leitura de arquivos ---------- */
function gridFromSheet(wb, sheetName){
  var ws = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:false, blankrows:true});
}

function rebuildFile(f){
  if(f.kind==='pdf'){
    var re;
    try{ re = new RegExp(f.pattern); }catch(e){ re = /\d{4,}/; }
    var rows = [], rowNums = [];
    f.lines.forEach(function(line, i){
      var m = line.match(re);
      if(m){ rows.push({'Valor extraído': m[0], 'Linha completa': line}); rowNums.push(i+1); }
    });
    f.table = {headers:['Valor extraído','Linha completa'], rows:rows, letters:['A','B'], rowNums:rowNums, headerRowNum:null};
    var pp = pairsFromPdfLines(f.lines);
    f.pairs = pp.length ? pp : null;
    f.declared = declaredCount(f.lines);
  } else {
    f.table = buildTable(f.aoa, f.startCell);
    f.pairs = pairsFromTable(f.table);
    if(f.pairs && !f.pairs.length) f.pairs = null;
    var texts = [];
    (f.aoa||[]).slice(0,15).forEach(function(r){ (r||[]).forEach(function(c){ if(typeof c==='string' && c) texts.push(c); }); });
    f.declared = declaredCount(texts);
  }
}

function parseWorkbookFile(file, kind, data, readOpts){
  var wb = XLSX.read(data, readOpts);
  var f = {name:file.name, kind:kind, workbook:wb, sheetNames:wb.SheetNames, activeSheet:wb.SheetNames[0], startCell:''};
  f.aoa = gridFromSheet(wb, f.activeSheet);
  rebuildFile(f);
  return f;
}

function parseExcelFile(file){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onload = function(e){
      try{ resolve(parseWorkbookFile(file, 'excel', new Uint8Array(e.target.result), {type:'array'})); }
      catch(err){ reject(err); }
    };
    reader.onerror = function(){ reject(new Error('Falha ao ler '+file.name)); };
    reader.readAsArrayBuffer(file);
  });
}
function parseCsvFile(file){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onload = function(e){
      try{ resolve(parseWorkbookFile(file, 'csv', e.target.result, {type:'string'})); }
      catch(err){ reject(err); }
    };
    reader.onerror = function(){ reject(new Error('Falha ao ler '+file.name)); };
    reader.readAsText(file, 'utf-8');
  });
}

function reconstructLines(items){
  var pts = items.map(function(it){ return {x: it.transform[4], y: Math.round(it.transform[5]*2)/2, str: it.str}; });
  pts.sort(function(a,b){ return (b.y-a.y) || (a.x-b.x); });
  var lines = [], cur = null, curY = null;
  pts.forEach(function(p){
    if(curY===null || Math.abs(p.y-curY) > 2.5){ cur = []; lines.push(cur); curY = p.y; }
    cur.push(p);
  });
  return lines.map(function(l){
    l.sort(function(a,b){return a.x-b.x;});
    return l.map(function(p){return p.str;}).join(' ').replace(/\s+/g,' ').trim();
  }).filter(function(s){return s.length>0;});
}

var PDF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
var pdfWorkerPromise = null;
/* Baixa o código do worker e cria um worker local (blob). Se não der, usa o endereço da CDN. */
function setupPdfWorker(){
  if(pdfWorkerPromise) return pdfWorkerPromise;
  pdfWorkerPromise = fetch(PDF_WORKER_URL)
    .then(function(r){ if(!r.ok) throw new Error('http '+r.status); return r.text(); })
    .then(function(code){
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], {type:'application/javascript'}));
    })
    .catch(function(){ pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL; });
  return pdfWorkerPromise;
}
/* Abre o PDF; se o worker falhar, tenta de novo com o endereço padrão da CDN. */
function openPdf(buffer){
  return pdfjsLib.getDocument({data:new Uint8Array(buffer.slice(0))}).promise.catch(function(err){
    if(/worker/i.test(String(err && err.message)) && pdfjsLib.GlobalWorkerOptions.workerSrc !== PDF_WORKER_URL){
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      return pdfjsLib.getDocument({data:new Uint8Array(buffer.slice(0))}).promise;
    }
    throw err;
  });
}

function parsePdfFile(file){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onload = function(e){
      try{
        if(typeof pdfjsLib === 'undefined'){ reject(new Error('Biblioteca de PDF não carregada. Verifique a conexão com a internet.')); return; }
        setupPdfWorker().then(function(){ return openPdf(e.target.result); }).then(function(pdf){
          var all = [];
          function next(p){
            if(p>pdf.numPages){
              var f = {name:file.name, kind:'pdf', lines:all, pattern:'\\d{4,}'};
              rebuildFile(f);
              resolve(f);
              return;
            }
            pdf.getPage(p).then(function(page){ return page.getTextContent(); }).then(function(tc){
              all = all.concat(reconstructLines(tc.items));
              next(p+1);
            }).catch(reject);
          }
          next(1);
        }).catch(reject);
      }catch(err){ reject(err); }
    };
    reader.onerror = function(){ reject(new Error('Falha ao ler '+file.name)); };
    reader.readAsArrayBuffer(file);
  });
}

function parseAnyFile(file){
  var ext = (file.name.split('.').pop()||'').toLowerCase();
  if(ext==='csv') return parseCsvFile(file);
  if(ext==='pdf') return parsePdfFile(file);
  return parseExcelFile(file);
}

function switchSheet(f, sheetName){
  f.activeSheet = sheetName;
  f.aoa = gridFromSheet(f.workbook, sheetName);
  rebuildFile(f);
}

/* ---------- consolida os arquivos de um campo ----------
   Presença: se todos os arquivos tiverem o padrão Matrícula + Nome, usa esse padrão.
   Caso contrário (ou se o usuário pedir ajuste manual), usa a tabela do arquivo. */
function recomputeSlot(tab, slotKey){
  var slot = tab.slots[slotKey];
  var isA = slotKey==='a';
  var usePairs = tab.type==='presenca' && !slot.manual && slot.files.length>0 &&
    slot.files.every(function(f){ return f.pairs && f.pairs.length; });
  slot.mode = usePairs ? 'pairs' : 'table';
  var headers = [], rows = [];
  if(usePairs){
    headers = ['Matrícula','Nome'];
    slot.files.forEach(function(f){ f.pairs.forEach(function(p){ rows.push({'Matrícula':p['Matrícula'], 'Nome':p['Nome'], __source:f.name}); }); });
    if(isA){ tab.keyColsA = ['Matrícula']; tab.nameColA = 'Nome'; } else { tab.keyColsB = ['Matrícula']; tab.nameColB = 'Nome'; }
  } else {
    slot.files.forEach(function(f){ f.table.headers.forEach(function(h){ if(headers.indexOf(h)<0) headers.push(h); }); });
    slot.files.forEach(function(f){
      f.table.rows.forEach(function(r){
        var o = {__source:f.name};
        headers.forEach(function(h){ o[h] = (h in r) ? r[h] : ''; });
        rows.push(o);
      });
    });
    var keys = isA ? tab.keyColsA : tab.keyColsB;
    var valid = keys.filter(function(k){ return headers.indexOf(k)>=0; });
    var nameCol = isA ? tab.nameColA : tab.nameColB;
    if(headers.indexOf(nameCol)<0) nameCol = '';
    if(!valid.length){
      for(var i=0;i<headers.length;i++){ if(/^matric/.test(headerBase(headers[i]))){ valid=[headers[i]]; break; } }
    }
    if(!nameCol){
      for(var j=0;j<headers.length;j++){ if(NAME_RE.test(headerBase(headers[j])) && valid.indexOf(headers[j])<0){ nameCol=headers[j]; break; } }
    }
    if(isA){ tab.keyColsA = valid; tab.nameColA = nameCol; } else { tab.keyColsB = valid; tab.nameColB = nameCol; }
  }
  slot.headers = headers;
  slot.rows = rows;
  tab.result = null;
}

window.__CA = {
  $:$, esc:esc, uid:uid, TYPE_DEFS:TYPE_DEFS, typeDef:typeDef, THRESHOLDS:THRESHOLDS, STATE:STATE,
  makeSlot:makeSlot, newTab:newTab, getTab:getTab, activeTab:activeTab, closeTab:closeTab,
  normalizeVal:normalizeVal, isBlank:isBlank, compositeKey:compositeKey,
  buildTable:buildTable, parseAnyFile:parseAnyFile, rebuildFile:rebuildFile, switchSheet:switchSheet,
  recomputeSlot:recomputeSlot, pairsFromTable:pairsFromTable, pairsFromPdfLines:pairsFromPdfLines
};
})();


/* ===================== Cálculo, resultados e exportação ===================== */
(function(){
"use strict";
var C = window.__CA;
var esc = C.esc, compositeKey = C.compositeKey;
var MAX_ROWS_SHOWN = 300;

function shownCols(keys, nameCol){
  var cols = keys.slice();
  if(nameCol && cols.indexOf(nameCol)<0) cols.push(nameCol);
  return cols;
}

/* ---------- Presença e participação ---------- */
function computePresenca(tab){
  var a = tab.slots.a, b = tab.slots.b;
  if(!a.rows.length) throw new Error('Anexe a matriz de referência (arquivo mãe).');
  if(!b.rows.length) throw new Error('Anexe a lista de presença (arquivo de conferência).');
  if(!tab.keyColsA.length) throw new Error('Escolha a coluna da matrícula na matriz de referência.');
  if(!tab.keyColsB.length) throw new Error('Escolha a coluna da matrícula na lista de presença.');
  var opts = tab.normOpts;
  var setB = {}, listUnique = 0;
  b.rows.forEach(function(r){
    var k = compositeKey(r, tab.keyColsB, opts);
    if(k!=='' && !setB[k]){ setB[k] = r; listUnique++; }
  });
  var refMap = {}, missing = [], present = [];
  a.rows.forEach(function(r){
    var k = compositeKey(r, tab.keyColsA, opts);
    if(k==='' || refMap[k]) return;
    refMap[k] = r;
    if(setB[k]) present.push(r); else missing.push(r);
  });
  var total = Object.keys(refMap).length;
  var extrasRaw = [];
  Object.keys(setB).forEach(function(k){ if(!refMap[k]) extrasRaw.push(setB[k]); });
  var percent = total>0 ? present.length/total*100 : 0;

  /* sempre mostra Matrícula e Nome; se um arquivo não tem o nome, usa o do outro arquivo */
  function nameOf(row, nameCol){ return nameCol && !C.isBlank(row[nameCol]) ? String(row[nameCol]).trim() : ''; }
  function view(row, keyCols, nameCol, otherMap){
    var k = compositeKey(row, keyCols, opts);
    var nome = nameOf(row, nameCol);
    if(!nome && otherMap[k]) nome = otherMap[k];
    return {'Matrícula': keyCols.map(function(c){ return row[c]; }).join(' / '), 'Nome': nome};
  }
  var namesA = {}, namesB = {};
  Object.keys(refMap).forEach(function(k){ var n = nameOf(refMap[k], tab.nameColA); if(n) namesA[k] = n; });
  Object.keys(setB).forEach(function(k){ var n = nameOf(setB[k], tab.nameColB); if(n) namesB[k] = n; });
  var COLS = ['Matrícula','Nome'];
  return {
    kind:'presenca', total:total, matched:present.length, percent:percent, threshold:tab.threshold,
    atingiu: percent >= tab.threshold, listTotal:listUnique,
    missing: missing.map(function(r){ return view(r, tab.keyColsA, tab.nameColA, namesB); }),
    extras: extrasRaw.map(function(r){ return view(r, tab.keyColsB, tab.nameColB, namesA); }),
    present: present.map(function(r){ return view(r, tab.keyColsA, tab.nameColA, namesB); }),
    colsA: COLS, colsB: COLS
  };
}

/* ---------- Diferença entre bases ---------- */
function computeDiferenca(tab){
  var a = tab.slots.a, b = tab.slots.b;
  if(!a.rows.length) throw new Error('Anexe o Arquivo Original (Versão Anterior).');
  if(!b.rows.length) throw new Error('Anexe o Arquivo Atualizado (Nova Versão).');
  if(!tab.keyColsA.length) throw new Error('Clique no cabeçalho da coluna-chave do Arquivo Original.');
  if(!tab.keyColsB.length) throw new Error('Clique no cabeçalho da coluna-chave do Arquivo Atualizado.');
  var opts = tab.normOpts;
  var mapA = {}, mapB = {};
  a.rows.forEach(function(r){ var k=compositeKey(r,tab.keyColsA,opts); if(k!=='' && !mapA[k]) mapA[k]=r; });
  b.rows.forEach(function(r){ var k=compositeKey(r,tab.keyColsB,opts); if(k!=='' && !mapB[k]) mapB[k]=r; });
  var commonCols = a.headers.filter(function(h){ return b.headers.indexOf(h)>=0 && tab.keyColsA.indexOf(h)<0; });
  var added=[], removed=[], changed=[];
  Object.keys(mapB).forEach(function(k){ if(!mapA[k]) added.push(mapB[k]); });
  Object.keys(mapA).forEach(function(k){
    if(!mapB[k]){ removed.push(mapA[k]); return; }
    var ra = mapA[k], rb = mapB[k], diffs = [];
    commonCols.forEach(function(c){
      var va = (ra[c]==null?'':String(ra[c]).trim());
      var vb = (rb[c]==null?'':String(rb[c]).trim());
      if(va!==vb) diffs.push({col:c, before:va, after:vb});
    });
    if(diffs.length) changed.push({key:k, keyText: tab.keyColsA.map(function(c){return ra[c];}).join(' / '), diffs:diffs});
  });
  return {kind:'diferenca', added:added, removed:removed, changed:changed, colsA:a.headers, colsB:b.headers};
}

function runComparison(tab){
  tab.error = null; tab.result = null;
  try{
    tab.result = tab.type==='diferenca' ? computeDiferenca(tab) : computePresenca(tab);
  }catch(err){ tab.error = err.message || String(err); }
}

/* ---------- exibição ---------- */
function rowsTable(headers, rows){
  if(!rows.length) return '<p class="hint">Nenhum registro.</p>';
  var shown = rows.slice(0, MAX_ROWS_SHOWN);
  var html = '<table class="result-table"><thead><tr>';
  headers.forEach(function(h){ html += '<th>'+esc(h)+'</th>'; });
  html += '</tr></thead><tbody>';
  shown.forEach(function(r){
    html += '<tr>';
    headers.forEach(function(h){ html += '<td>'+esc(r[h])+'</td>'; });
    html += '</tr>';
  });
  html += '</tbody></table>';
  if(rows.length>MAX_ROWS_SHOWN) html += '<p class="hint">Mostrando '+MAX_ROWS_SHOWN+' de '+rows.length+' registros. Exporte para Excel para ver todos.</p>';
  return html;
}
function block(title, count, body, open){
  return '<details class="result-block"'+(open?' open':'')+'><summary>'+esc(title)+' <span class="hint" style="margin:0;">('+esc(count)+')</span></summary><div class="inner">'+body+'</div></details>';
}

function renderPresencaResult(r){
  var cls = r.atingiu ? 'good' : 'critical';
  var html = '<div class="card"><div class="summary-cards">' +
    '<div class="stat"><div class="num">'+r.total+'</div><div class="lbl">Total esperado (matriz)</div></div>' +
    '<div class="stat"><div class="num">'+r.matched+'</div><div class="lbl">Encontrados na lista</div></div>' +
    '<div class="stat"><div class="num">'+r.percent.toFixed(1)+'%</div><div class="lbl">Percentual atingido</div></div>' +
    '<div class="stat"><div class="num">'+r.threshold+'%</div><div class="lbl">Meta exigida</div></div>' +
    '<div class="stat"><div class="num">'+r.listTotal+'</div><div class="lbl">Pessoas na lista</div></div>' +
    '</div>' +
    '<div class="bar-bg"><div class="bar-fill'+(r.atingiu?'':' critical')+'" style="width:'+Math.min(100,r.percent)+'%;"></div></div>' +
    '<span class="badge '+cls+'">'+(r.atingiu?'✅ Meta atingida':'⚠️ Meta não atingida')+'</span></div>';
  html += block('Faltantes: (Estão na Base de Referência e não estão na Base para Comparação)', r.missing.length+' registro(s)', rowsTable(r.colsA, r.missing), true);
  html += block('Fora da Base de Referência: (Estão na Base para Comparação e não estão na Base de Referência)', r.extras.length+' registro(s)', rowsTable(r.colsB, r.extras));
  html += block('Presentes identificados nos dois arquivos', r.present.length+' registro(s)', rowsTable(r.colsA, r.present));
  return html;
}

function renderDiferencaResult(r){
  var html = '<div class="card"><div class="summary-cards">' +
    '<div class="stat"><div class="num diff-add">'+r.added.length+'</div><div class="lbl">Adicionados</div></div>' +
    '<div class="stat"><div class="num diff-rem">'+r.removed.length+'</div><div class="lbl">Removidos</div></div>' +
    '<div class="stat"><div class="num diff-chg">'+r.changed.length+'</div><div class="lbl">Alterados</div></div>' +
    '</div></div>';
  html += block('Adicionados (estão no Arquivo Atualizado, não estavam no Arquivo Original)', r.added.length+' registro(s)', rowsTable(r.colsB, r.added), true);
  html += block('Removidos (estavam no Arquivo Original, não estão no Arquivo Atualizado)', r.removed.length+' registro(s)', rowsTable(r.colsA, r.removed), true);
  var ch = r.changed.map(function(c){
    return {'Chave': c.keyText, 'Alterações': c.diffs.map(function(d){ return d.col+': "'+d.before+'" → "'+d.after+'"'; }).join(' | ')};
  });
  html += block('Alterados (mesma chave, valores diferentes)', r.changed.length+' registro(s)', rowsTable(['Chave','Alterações'], ch));
  return html;
}

function renderResult(tab){
  return tab.result.kind==='diferenca' ? renderDiferencaResult(tab.result) : renderPresencaResult(tab.result);
}

/* ---------- exportação ---------- */
function exportResult(tab){
  var r = tab.result; if(!r) return;
  var wb = XLSX.utils.book_new();
  function strip(rows, cols){
    return rows.map(function(x){ var o={}; cols.forEach(function(c){ o[c]=x[c]; }); return o; });
  }
  function add(name, rows){
    if(!rows.length) rows = [{info:'Nenhum registro'}];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0,31));
  }
  if(r.kind==='presenca'){
    add('Resumo', [{'Total esperado':r.total, 'Encontrados':r.matched, 'Percentual':r.percent.toFixed(1)+'%', 'Meta':r.threshold+'%', 'Atingiu':r.atingiu?'Sim':'Não', 'Pessoas na lista':r.listTotal}]);
    add('Faltantes', strip(r.missing, r.colsA));
    add('Fora da matriz', strip(r.extras, r.colsB));
    add('Presentes esperados', strip(r.present, r.colsA));
  } else {
    add('Resumo', [{'Adicionados':r.added.length, 'Removidos':r.removed.length, 'Alterados':r.changed.length}]);
    add('Adicionados', strip(r.added, r.colsB));
    add('Removidos', strip(r.removed, r.colsA));
    add('Alterados', r.changed.map(function(c){ return {'Chave':c.keyText, 'Alterações':c.diffs.map(function(d){return d.col+': '+d.before+' -> '+d.after;}).join(' | ')}; }));
  }
  XLSX.writeFile(wb, 'conferencia_'+tab.type+'_'+tab.seq+'.xlsx');
}

Object.assign(C, {runComparison:runComparison, renderResult:renderResult, exportResult:exportResult});
})();


/* ===================== Interface e eventos ===================== */
(function(){
"use strict";
var C = window.__CA;
var $ = C.$, esc = C.esc, STATE = C.STATE;
var PREVIEW_ROWS = 6;

/* ---------- pré-visualização ---------- */
function previewTable(f, selected, slotKey){
  var t = f.table;
  if(!t.headers.length) return '<p class="hint">Nenhum dado encontrado nesta aba. Se a tabela não começa no topo, informe a célula inicial (ex: A5).</p>';
  var html = '<div class="preview-wrap"><table class="preview"><thead><tr><th class="rownum">linha</th>';
  t.headers.forEach(function(h, i){
    var sel = selected.indexOf(h)>=0;
    html += '<th class="pick'+(sel?' sel':'')+'" data-action="pick-col" data-slot="'+slotKey+'" data-col="'+esc(h)+'" title="Clique para escolher esta coluna">' +
      '<span class="letter">'+esc(t.letters[i]||'')+'</span>'+esc(h)+'</th>';
  });
  html += '</tr></thead><tbody>';
  t.rows.slice(0, PREVIEW_ROWS).forEach(function(r, ri){
    html += '<tr><td class="rownum">'+(t.rowNums[ri]||'')+'</td>';
    t.headers.forEach(function(h){ html += '<td>'+esc(r[h])+'</td>'; });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  var note = (t.headerRowNum ? 'Cabeçalho lido na linha '+t.headerRowNum+'. ' : '') + 'Mostrando '+Math.min(PREVIEW_ROWS,t.rows.length)+' de '+t.rows.length+' linhas. Linhas e colunas em branco são ignoradas.';
  return html + '<p class="hint">'+note+'</p>';
}

function pairsPreview(f){
  var html = '<div class="preview-wrap"><table class="preview"><thead><tr><th>Matrícula</th><th>Nome</th></tr></thead><tbody>';
  f.pairs.slice(0, PREVIEW_ROWS).forEach(function(p){ html += '<tr><td>'+esc(p['Matrícula'])+'</td><td>'+esc(p['Nome'])+'</td></tr>'; });
  html += '</tbody></table></div>';
  return html + '<p class="hint">Mostrando '+Math.min(PREVIEW_ROWS,f.pairs.length)+' de '+f.pairs.length+' pessoas identificadas.</p>';
}

function fileStatus(tab, f){
  if(tab.type!=='presenca') return '';
  if(f.pairs){
    var txt = '✅ '+f.pairs.length+' pessoa(s) identificada(s) com Matrícula e Nome';
    var cls = 'ok';
    if(f.declared!=null){
      if(f.declared===f.pairs.length) txt += ' (confere com o total informado no arquivo: '+f.declared+')';
      else { txt += ' (o arquivo informa '+f.declared+', confira)'; cls = 'warn'; }
    }
    var semNome = f.pairs.every(function(p){ return !p['Nome']; });
    if(semNome){ txt += '. Atenção: a coluna do nome não foi identificada, use "Ajustar colunas manualmente" para escolhê-la'; cls = 'warn'; }
    return '<div class="status '+cls+'">'+txt+'</div>';
  }
  return '<div class="status warn">⚠️ Não encontramos as colunas Matrícula e Nome automaticamente. Clique no cabeçalho da coluna da matrícula na tabela abaixo ou informe a célula inicial.</div>';
}

function renderSlot(tab, key){
  var slot = tab.slots[key];
  var selected = key==='a' ? tab.keyColsA : tab.keyColsB;
  var html = '<label class="dropzone" data-dz="'+key+'">📁 <span>Clique ou arraste arquivo(s) Excel, CSV ou PDF</span>' +
    '<input type="file" multiple accept=".xlsx,.xls,.csv,.pdf" data-action="add-file" data-slot="'+key+'"></label>';
  if(!slot.files.length){
    return html + '<p class="hint" style="margin-top:6px;">Nenhum arquivo anexado ainda.</p>';
  }
  slot.files.forEach(function(f, idx){
    html += '<div class="file-block"><div class="file-chip">' +
      '<span class="fname" title="'+esc(f.name)+'">'+(f.kind==='pdf'?'📄':'📊')+' '+esc(f.name)+'</span>' +
      '<span class="fmeta">'+f.table.rows.length+' linha(s) lida(s)</span>' +
      '<span class="frm" title="Remover" data-action="remove-file" data-slot="'+key+'" data-fidx="'+idx+'">✕</span></div>';
    html += '<div class="slot-tools">';
    if(f.kind==='excel'){
      html += '<span>Aba:</span><select data-action="switch-sheet" data-slot="'+key+'" data-fidx="'+idx+'">' +
        f.sheetNames.map(function(s){ return '<option value="'+esc(s)+'"'+(s===f.activeSheet?' selected':'')+'>'+esc(s)+'</option>'; }).join('') + '</select>';
    }
    if(f.kind!=='pdf'){
      html += '<span>Começar na célula (opcional):</span><input type="text" placeholder="ex: A5" value="'+esc(f.startCell)+'" data-action="set-start" data-slot="'+key+'" data-fidx="'+idx+'">';
    } else if(slot.mode==='table'){
      html += '<span>Padrão de leitura (regex):</span><input type="text" style="width:120px;" value="'+esc(f.pattern)+'" data-action="reprocess-pdf" data-slot="'+key+'" data-fidx="'+idx+'">';
    }
    html += '</div>';
    html += fileStatus(tab, f);
    html += slot.mode==='pairs' ? pairsPreview(f) : previewTable(f, selected, key);
    html += '</div>';
  });

  if(tab.type==='presenca'){
    if(slot.mode==='pairs'){
      html += '<div class="field-row"><button class="link-btn" data-action="toggle-manual" data-slot="'+key+'">Ajustar colunas manualmente</button></div>';
    } else {
      var allPairs = slot.files.every(function(f){ return f.pairs && f.pairs.length; });
      var nameCol = key==='a' ? tab.nameColA : tab.nameColB;
      html += '<div class="field-row"><span>Coluna de referência:</span>' + colSelect(slot.headers, selected[0]||'', 'data-action="set-key-col" data-slot="'+key+'"') +
        '<span>Coluna de referência:</span>' + colSelect(slot.headers, nameCol||'', 'data-action="set-name-col" data-slot="'+key+'"', '(nenhuma)') +
        (allPairs ? '<button class="link-btn" data-action="toggle-manual" data-slot="'+key+'">Voltar para a detecção automática</button>' : '') + '</div>';
    }
  } else {
    html += '<div class="field-row"><span>Coluna(s)-chave marcada(s):</span>' +
      (selected.length ? selected.map(function(c){ return '<span class="key-chip selected">'+esc(c)+'</span>'; }).join('') : '<span class="hint" style="margin:0;">clique nos cabeçalhos da tabela acima para marcar</span>') + '</div>';
  }
  return html;
}

function colSelect(headers, current, attrs, placeholder){
  return '<select '+attrs+'><option value="">'+(placeholder||'(selecione)')+'</option>' + headers.map(function(h){
    return '<option value="'+esc(h)+'"'+(h===current?' selected':'')+'>'+esc(h)+'</option>';
  }).join('') + '</select>';
}

function renderNorm(tab){
  return '<div style="margin-top:6px;">' +
    '<label class="chk"><input type="checkbox" data-action="toggle-norm" data-opt="onlyAlnum" '+(tab.normOpts.onlyAlnum?'checked':'')+'> Considerar apenas letras e números (ignora pontos, traços e outros símbolos)</label>' +
    '<label class="chk"><input type="checkbox" data-action="toggle-norm" data-opt="stripZeros" '+(tab.normOpts.stripZeros?'checked':'')+'> Ignorar zeros à esquerda (ex: "00123" = "123")</label></div>';
}

function changeLink(){ return '<button class="change-type-link" data-action="change-type">trocar tipo de conferência</button>'; }

function wizardPresenca(tab){
  var html = '<div class="card"><h2><span class="stepnum">1</span>Critérios da Conferência'+changeLink()+'</h2>' +
    '<p class="hint">A conferência é considerada <b>atingida</b> quando a quantidade de registros da base de referência identificados na base de comparação corresponder, no mínimo, ao percentual definido em relação ao total de registros esperados na base de referência.</p>' +
    '<div class="threshold-options">' + C.THRESHOLDS.map(function(v){
      return '<div class="th-pill'+(tab.threshold===v?' selected':'')+'" data-action="set-threshold" data-val="'+v+'">'+v+'%</div>';
    }).join('') + '</div>' +
    '<h3 style="margin-top:10px;">Opções de normalização da matrícula</h3>' + renderNorm(tab) + '</div>';
  html += '<div class="card"><h2><span class="stepnum">2</span>Base de Referência</h2>' + renderSlot(tab,'a') + '</div>';
  html += '<div class="card"><h2><span class="stepnum">3</span>Base para Comparação</h2>' +
    '<p class="hint">Representa o arquivo que será confrontado com a base de referência.</p>' +
    renderSlot(tab,'b') + '</div>';
  return html;
}

function wizardDiferenca(tab){
  var html = '<div class="card"><h2><span class="stepnum">1</span>Arquivo Original (Versão Anterior)'+changeLink()+'</h2>' + renderSlot(tab,'a') + '</div>';
  html += '<div class="card"><h2><span class="stepnum">2</span>Arquivo Atualizado (Nova Versão)</h2>' + renderSlot(tab,'b') + '</div>';
  html += '<div class="card"><h3>Opções de normalização da chave</h3>' + renderNorm(tab) + '</div>';
  return html;
}

function renderTypeGrid(){
  return '<div class="card"><h2>O que você deseja conferir?</h2><div class="type-grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr));">' +
    C.TYPE_DEFS.map(function(t){
      return '<div class="type-card" data-action="select-type" data-type="'+t.id+'"><div class="ticon">'+t.icon+'</div>' +
        '<div class="ttitle">'+esc(t.title)+'</div><div class="tdesc">'+esc(t.desc)+'</div></div>';
    }).join('') + '</div></div>';
}

function renderPanel(tab){
  if(!tab.type) return renderTypeGrid();
  var can = tab.slots.a.rows.length>0 && tab.slots.b.rows.length>0;
  var html = tab.type==='presenca' ? wizardPresenca(tab) : wizardDiferenca(tab);
  html += '<div class="card"><div class="run-row"><button class="btn" data-action="run"'+(can?'':' disabled')+'>▶ Executar conferência</button>' +
    (tab.result ? '<button class="btn secondary" data-action="export">⬇ Exportar Excel</button><button class="btn secondary" data-action="print">🖨 Imprimir</button>' : '') + '</div>';
  if(tab.error) html += '<div class="err-msg">⚠ '+esc(tab.error)+'</div>';
  html += '</div>';
  if(tab.result) html += C.renderResult(tab);
  return html;
}

function renderTabsBar(){
  $('#tabsBar').innerHTML = STATE.tabs.map(function(t){
    var def = C.typeDef(t.type);
    return '<div class="tab-btn'+(t.id===STATE.activeId?' active':'')+'" data-action="switch-tab" data-id="'+t.id+'">' +
      '<span class="tname">'+(def?def.icon:'📝')+' '+esc(t.name)+'</span>' +
      '<span class="tclose" data-action="close-tab" data-id="'+t.id+'" title="Fechar">✕</span></div>';
  }).join('') + '<div class="tab-add" data-action="new-tab" title="Nova conferência">+</div>';
}

function render(){
  renderTabsBar();
  var tab = C.activeTab();
  $('#tabPanels').innerHTML = tab ? renderPanel(tab) : '';
}

/* ---------- ações ---------- */
function resetType(tab){
  tab.slots = {a:C.makeSlot('a'), b:C.makeSlot('b')};
  tab.keyColsA = []; tab.keyColsB = []; tab.nameColA = ''; tab.nameColB = '';
  tab.result = null; tab.error = null;
}

function handleFiles(tab, key, fileList){
  var files = Array.prototype.slice.call(fileList||[]);
  if(!files.length) return;
  tab.error = null;
  Promise.all(files.map(function(f){
    return C.parseAnyFile(f).catch(function(err){
      tab.error = 'Erro ao ler "'+f.name+'": '+(err && err.message ? err.message : err);
      return null;
    });
  })).then(function(results){
    var slot = tab.slots[key];
    results.forEach(function(r){ if(r) slot.files.push(r); });
    C.recomputeSlot(tab, key);
    render();
  });
}

function fileOf(tab, el){
  return tab.slots[el.getAttribute('data-slot')].files[parseInt(el.getAttribute('data-fidx'),10)];
}

function onClick(e){
  var el = e.target.closest('[data-action]');
  if(!el || el.tagName==='INPUT' || el.tagName==='SELECT') return;
  var action = el.getAttribute('data-action');
  var tab = C.activeTab();
  var key = el.getAttribute('data-slot');
  switch(action){
    case 'new-tab': C.newTab(); render(); break;
    case 'switch-tab': STATE.activeId = el.getAttribute('data-id'); render(); break;
    case 'close-tab': e.stopPropagation(); C.closeTab(el.getAttribute('data-id')); render(); break;
    case 'select-type': tab.type = el.getAttribute('data-type'); resetType(tab); render(); break;
    case 'change-type': tab.type = null; resetType(tab); render(); break;
    case 'remove-file': tab.slots[key].files.splice(parseInt(el.getAttribute('data-fidx'),10),1); C.recomputeSlot(tab,key); render(); break;
    case 'toggle-manual': tab.slots[key].manual = !tab.slots[key].manual; C.recomputeSlot(tab,key); render(); break;
    case 'pick-col': {
      var col = el.getAttribute('data-col');
      var field = key==='a' ? 'keyColsA' : 'keyColsB';
      if(tab.type==='presenca'){ tab[field] = [col]; }
      else { var i = tab[field].indexOf(col); if(i>=0) tab[field].splice(i,1); else tab[field].push(col); }
      tab.result = null; render(); break;
    }
    case 'set-threshold': tab.threshold = parseInt(el.getAttribute('data-val'),10); tab.result = null; render(); break;
    case 'run': C.runComparison(tab); render(); break;
    case 'export': C.exportResult(tab); break;
    case 'print': window.print(); break;
  }
}

function onChange(e){
  var el = e.target.closest('[data-action]');
  if(!el) return;
  var action = el.getAttribute('data-action');
  var tab = C.activeTab();
  var key = el.getAttribute('data-slot');
  switch(action){
    case 'add-file': handleFiles(tab, key, el.files); el.value = ''; break;
    case 'switch-sheet': C.switchSheet(fileOf(tab,el), el.value); C.recomputeSlot(tab,key); render(); break;
    case 'set-start': { var f = fileOf(tab,el); f.startCell = el.value; C.rebuildFile(f); C.recomputeSlot(tab,key); render(); break; }
    case 'reprocess-pdf': { var p = fileOf(tab,el); p.pattern = el.value; C.rebuildFile(p); C.recomputeSlot(tab,key); render(); break; }
    case 'toggle-norm': tab.normOpts[el.getAttribute('data-opt')] = el.checked; tab.result = null; break;
    case 'set-key-col': if(key==='a') tab.keyColsA = el.value?[el.value]:[]; else tab.keyColsB = el.value?[el.value]:[]; tab.result = null; render(); break;
    case 'set-name-col': if(key==='a') tab.nameColA = el.value; else tab.nameColB = el.value; tab.result = null; break;
  }
}

function onDragOver(e){ var dz = e.target.closest && e.target.closest('.dropzone'); if(!dz) return; e.preventDefault(); dz.classList.add('dragover'); }
function onDragLeave(e){ var dz = e.target.closest && e.target.closest('.dropzone'); if(dz) dz.classList.remove('dragover'); }
function onDrop(e){
  var dz = e.target.closest && e.target.closest('.dropzone');
  if(!dz) return;
  e.preventDefault(); dz.classList.remove('dragover');
  if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(C.activeTab(), dz.getAttribute('data-dz'), e.dataTransfer.files);
}

function init(){
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  C.newTab();
  render();
}
if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();

