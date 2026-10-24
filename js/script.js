// ============================================================
// DATABASE — IndexedDB
// ============================================================
const DB_NAME='PontoSmart',DB_VER=3;
let db;
function initDB(){
  return new Promise((res,rej)=>{
    const req=indexedDB.open(DB_NAME,DB_VER);
    req.onupgradeneeded=e=>{
      const d=e.target.result;
      const tx=e.target.transaction;
      // USERS store
      if(!d.objectStoreNames.contains('users')){
        const us=d.createObjectStore('users',{keyPath:'username'});
        us.createIndex('email','email',{unique:true});
      }
      // RECORDS store — recriar se veio de versão antiga sem os índices certos
      if(d.objectStoreNames.contains('records')){
        const rs=tx.objectStore('records');
        // Garantir que os índices existem
        if(!rs.indexNames.contains('uMonth'))rs.createIndex('uMonth',['username','ym'],{unique:false});
        if(!rs.indexNames.contains('uDate'))rs.createIndex('uDate',['username','date'],{unique:false});
        // remover índice antigo se existir
        if(rs.indexNames.contains('userMonth'))rs.deleteIndex('userMonth');
        if(rs.indexNames.contains('userDate'))rs.deleteIndex('userDate');
      } else {
        const rs=d.createObjectStore('records',{keyPath:'id',autoIncrement:true});
        rs.createIndex('uMonth',['username','ym'],{unique:false});
        rs.createIndex('uDate',['username','date'],{unique:false});
      }
    };
    req.onsuccess=e=>{db=e.target.result;res();};
    req.onerror=e=>{console.error('DB Error',e);rej(req.error);};
    req.onblocked=()=>{alert('Feche outras abas do PontoSmart e recarregue a página.');};
  });
}
function dbGet(s,k){
  return new Promise((r,j)=>{
    try{const t=db.transaction(s,'readonly');const q=t.objectStore(s).get(k);q.onsuccess=()=>r(q.result);q.onerror=e=>{console.error('dbGet',e);j(q.error)};}
    catch(e){console.error('dbGet catch',e);j(e);}
  });
}
function dbIdx(s,i,v){
  return new Promise((r,j)=>{
    try{const t=db.transaction(s,'readonly');const q=t.objectStore(s).index(i).getAll(v);q.onsuccess=()=>r(q.result||[]);q.onerror=e=>{console.error('dbIdx',e);r([]);};}
    catch(e){console.error('dbIdx catch',s,i,v,e);r([]);}
  });
}
function dbAll(s){
  return new Promise((r,j)=>{
    try{const t=db.transaction(s,'readonly');const q=t.objectStore(s).getAll();q.onsuccess=()=>r(q.result||[]);q.onerror=e=>{console.error('dbAll',e);r([]);};}
    catch(e){console.error('dbAll catch',e);r([]);}
  });
}
let dbPut=(s,o)=>{
  return new Promise((r,j)=>{
    try{const t=db.transaction(s,'readwrite');const q=t.objectStore(s).put(o);q.onsuccess=()=>r(q.result);q.onerror=e=>{console.error('dbPut',e);j(q.error);};}
    catch(e){console.error('dbPut catch',e);j(e);}
  });
}
let dbDel=(s,k)=>{
  return new Promise((r,j)=>{
    try{const t=db.transaction(s,'readwrite');const q=t.objectStore(s).delete(k);q.onsuccess=()=>r();q.onerror=e=>{console.error('dbDel',e);j(q.error);};}
    catch(e){console.error('dbDel catch',e);j(e);}
  });
}
async function hashP(p){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(p+'ps_salt_v2'));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');}

// ============================================================
// FILE SYSTEM — backup automático em pasta local (Chrome/Edge)
// ============================================================
const FS_SUPPORTED=('showDirectoryPicker' in window);
let _fsDir=null;       // FileSystemDirectoryHandle
let _syncTimer=null;   // debounce para não gravar a cada tecla
const FS_FILENAME='pontoSmart_dados.json';
const FS_DIR_KEY='ps_fsDir'; // nome da permissão salva

// Tenta re-obter permissão de uma pasta já escolhida anteriormente
async function fsRestore(){
  if(!FS_SUPPORTED)return false;
  try{
    const roots=await navigator.storage.getDirectory().catch(()=>null);
    // Tenta recuperar handle salvo via IndexedDB
    const saved=await _origGet('users','__fsDir__').catch(()=>null);
    if(saved&&saved._dirHandle){
      const handle=saved._dirHandle;
      const perm=await handle.queryPermission({mode:'readwrite'});
      if(perm==='granted'){_fsDir=handle;return true;}
      // Tenta pedir permissão silenciosamente (só funciona com gesto do user)
      const req=await handle.requestPermission({mode:'readwrite'}).catch(()=>'denied');
      if(req==='granted'){_fsDir=handle;return true;}
    }
  }catch(e){}
  return false;
}

// Usuário escolhe a pasta
async function fsChooseDir(){
  if(!FS_SUPPORTED){
    toast('Seu navegador não suporta esta função. Use Chrome ou Edge.','⚠️');
    return false;
  }
  try{
    const handle=await window.showDirectoryPicker({mode:'readwrite',startIn:'documents'});
    _fsDir=handle;
    // Salva o handle no IndexedDB usando função original (não dispara sync)
    await _origPut('users',{username:'__fsDir__',_dirHandle:handle});
    await syncToFile(true);
    toast('Pasta vinculada! Dados serão salvos automaticamente em: '+handle.name,'📁');
    updateFsStatus();
    return true;
  }catch(e){
    if(e.name!=='AbortError') toast('Erro ao escolher pasta: '+e.message,'❌');
    return false;
  }
}

// Serializa todo o IndexedDB e grava no arquivo JSON
async function syncToFile(force=false){
  if(!_fsDir)return;
  clearTimeout(_syncTimer);
  const doSync=async()=>{
    try{
      const users=(await dbAll('users')).filter(u=>u.username!=='__fsDir__');
      const records=await dbAll('records');
      const payload=JSON.stringify({v:1,ts:Date.now(),users,records},null,2);
      const fh=await _fsDir.getFileHandle(FS_FILENAME,{create:true});
      const w=await fh.createWritable();
      await w.write(payload);
      await w.close();
    }catch(e){
      console.warn('syncToFile erro:',e);
    }
  };
  if(force) await doSync();
  else _syncTimer=setTimeout(doSync,800); // debounce 800ms
}

// Importa dados do arquivo JSON para o IndexedDB
async function fsImportFromFile(){
  if(!_fsDir){toast('Nenhuma pasta vinculada.','⚠️');return;}
  try{
    const fh=await _fsDir.getFileHandle(FS_FILENAME).catch(()=>null);
    if(!fh){toast('Arquivo não encontrado na pasta.','⚠️');return;}
    const file=await fh.getFile();
    const text=await file.text();
    const data=JSON.parse(text);
    if(!data.users||!data.records){toast('Arquivo inválido.','❌');return;}
    // Restaura users usando funções originais (sem disparar sync durante a importação)
    for(const u of data.users) await _origPut('users',u);
    // Restaura records — limpa os existentes primeiro
    const allRecs=await _origAll('records');
    for(const r of allRecs) await _origDel('records',r.id);
    for(const r of data.records){const rc={...r};delete rc.id;await _origPut('records',rc);}
    toast('Dados restaurados com sucesso! Recarregando...','✅');
    setTimeout(()=>location.reload(),1500);
  }catch(e){
    toast('Erro ao importar: '+e.message,'❌');
  }
}

// Atualiza indicador visual de status do arquivo
function updateFsStatus(){
  const el=document.getElementById('fsStatus');
  if(!el)return;
  if(!FS_SUPPORTED){
    el.innerHTML='<span style="color:var(--text2);font-size:12px">⚠️ Navegador não suporta (use Chrome/Edge)</span>';
    return;
  }
  if(_fsDir){
    el.innerHTML=`<span style="color:var(--green);font-size:12px">✅ Vinculado: <strong>${_fsDir.name}</strong></span>
    <button class="bs" style="padding:2px 10px;font-size:11px;margin-left:8px" onclick="fsChooseDir()">Trocar pasta</button>
    <button class="bs" style="padding:2px 10px;font-size:11px;margin-left:4px" onclick="fsImportFromFile()">Restaurar backup</button>`;
  } else {
    el.innerHTML=`<button class="bs ba" style="font-size:12px" onclick="fsChooseDir()">📁 Vincular pasta de backup</button>
    <span style="color:var(--text2);font-size:11px;margin-left:8px">Salve seus dados em uma pasta do computador</span>`;
  }
}

// Guarda referências originais ANTES das interceptações (não sofrem hoisting pois são const)
const _origPut=dbPut,_origDel=dbDel,_origGet=dbGet,_origAll=dbAll;

// Sobrescreve com arrow functions (sem hoisting) para disparar sync automático
dbPut=(s,o)=>_origPut(s,o).then(r=>{if(!(s==='users'&&o.username==='__fsDir__'))syncToFile();return r;});
dbDel=(s,k)=>_origDel(s,k).then(r=>{syncToFile();return r;});

// ============================================================
// CONSTANTS & STATE
// ============================================================
const MONTHS=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const DSEM=['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
let CU=null; // currentUser
let fgTgt=null;

// ============================================================
// UTILS — TIME
// ============================================================
function toMins(str){if(!str)return null;const[h,m]=str.split(':').map(Number);return h*60+m;}
function toHM(mins){
  if(mins===null||mins===undefined)return '--';
  const s=mins<0?'-':'';const a=Math.abs(mins);
  return `${s}${Math.floor(a/60)}h ${String(a%60).padStart(2,'0')}m`;
}
function toHMPos(mins){// always show as positive with sign
  const s=mins<0?'-':'+';const a=Math.abs(mins);
  return `${s}${Math.floor(a/60)}h ${String(a%60).padStart(2,'0')}m`;
}
function getYM(d){const x=new Date(d+'T00:00:00');return x.getFullYear()*100+(x.getMonth()+1);}
function ymLabel(ym){return MONTHS[(ym%100)-1]+' / '+Math.floor(ym/100);}
function dayName(d){return DSEM[new Date(d+'T00:00:00').getDay()];}
function isWE(d){const w=new Date(d+'T00:00:00').getDay();return w===0||w===6;}
function isSunday(d){return new Date(d+'T00:00:00').getDay()===0;}
function isSaturday(d){return new Date(d+'T00:00:00').getDay()===6;}

// Count weekdays in a month (for variable jornada)
function countWeekdays(y,m){
  let c=0;const days=new Date(y,m,0).getDate();
  for(let d=1;d<=days;d++){const w=new Date(y,m-1,d).getDay();if(w!==0&&w!==6)c++;}
  return c;
}

// ============================================================
// CORE CALCULATION — CORRIGIDA
// ============================================================
/*
  Regras:
  1. obs=FERIADO / obs=FOLGA / obs=ATESTADO / obs=FERIAS / obs=ABONO / obs=BANCO_COMP
     → jornada do dia = 0 → saldo = horas trabalhadas (puras, sem desconto)
  2. obs=EXTRA_100 (marcou que trabalhou no feriado/domingo como extra)
     → jornada do dia = 0 → TUDO que trabalhou é extra 100% → saldo = +trabalhado
  3. Fim de semana SEM obs especial (obs='' = "Dia Normal" explícito)
     → tratado como dia útil normal: desconta a jornada do dia e PODE ficar negativo
     (corrige bug: antes todo fim de semana zerava a jornada mesmo com "Dia Normal"
     selecionado, fazendo o saldo ficar sempre igual ao bruto trabalhado e nunca negativo)
  4. obs=FALTA → saldo negativo da jornada inteira (jornada calculada normalmente,
     inclusive em fim de semana se ele fizer parte da jornada configurada)
  5. Dia útil normal → saldo = trabalhado - jornada_dia
  6. Tolerância: se |saldo| <= tolerancia → saldo = 0
*/
function getJornadaDia(dateStr, obs){
  // Casos em que a jornada esperada é ZERO (não há débito por não trabalhar)
  const noJornada=['EXTRA_100','EXTRA_100_FERIADO','EXTRA_100_DOMINGO','FERIADO','FOLGA','ATESTADO','FERIAS','ABONO','BANCO_COMP'];
  if(noJornada.includes(obs)) return 0;
  // Fim de semana só zera a jornada se NÃO houver "Dia Normal" explícito.
  // obs==='' em fim de semana significa que o usuário escolheu ativamente
  // "— Dia Normal —" no lugar da sugestão automática de EXTRA_100.
  if(isWE(dateStr) && obs!=='') return 0;

  // Dia útil — calcular jornada diária conforme modo configurado
  const jornada=CU.jornada||220; // horas/mês
  const modo=CU.modo||'clt30';
  let jornadaDia;

  if(modo==='manual'){
    // Usuário definiu a jornada diária diretamente em minutos
    jornadaDia=CU.jornadaDiaMin||440; // padrão 7h20m
  } else if(modo==='div22'){
    // Fixo ÷ 22 dias úteis
    jornadaDia=(jornada*60)/22;
  } else if(modo==='uteis'){
    // ÷ dias úteis reais do mês
    const ym=getYM(dateStr);
    const y=Math.floor(ym/100),m=ym%100;
    const uteis=countWeekdays(y,m);
    jornadaDia=(jornada*60)/uteis;
  } else {
    // padrão 'clt30': 220h ÷ 30 = 7h20m (CLT: 44h/semana ÷ 6 dias)
    // Equivalente a: jornada mensal ÷ 30
    jornadaDia=(jornada*60)/30;
  }
  return Math.round(jornadaDia);
}

function calcRec(rec){
  const obs=rec.obs||'';
  const entrada=rec.entrada,saida=rec.saida;
  const saiInt=rec.saidaIntervalo,ret=rec.retorno;

  // Caso sem horários: só obs
  if(!entrada||!saida){
    if(obs==='FALTA'){
      // FALTA sem horário = dia completo negativo — calcular jornada normal do dia
      const jorn=getJornadaDia(rec.date,''); // passa obs vazio para pegar jornada normal
      return{horasTrab:0,intervalo:0,saldo:-jorn,extra100:0,jornadaDia:jorn};
    }
    return{horasTrab:0,intervalo:0,saldo:0,extra100:0,jornadaDia:getJornadaDia(rec.date,obs)};
  }

  const eM=toMins(entrada);
  const sM=toMins(saida);
  const siM=saiInt?toMins(saiInt):null;
  const rM=ret?toMins(ret):null;

  let trabMins;
  if(siM!==null&&rM!==null){
    trabMins=(siM-eM)+(sM-rM);
  } else {
    trabMins=sM-eM;
  }
  if(trabMins<0) trabMins=0;

  const intervMins=(siM!==null&&rM!==null)?Math.max(0,rM-siM):0;
  const jornadaDia=getJornadaDia(rec.date,obs);
  const tol=CU.tolerancia||10;

  let saldo,extra100=0;
  if(obs==='EXTRA_100'||obs==='EXTRA_100_FERIADO'||obs==='EXTRA_100_DOMINGO'){
    // Hora extra 100% — paga em separado a 2× o valor-hora.
    // NÃO entra no saldo do banco de horas.
    // EXTRA_100_FERIADO e EXTRA_100_DOMINGO contam como dia de repouso no DSR.
    saldo=0;
    extra100=trabMins;
  } else if(obs==='FALTA'){
    saldo=-jornadaDia;
    extra100=0;
  } else {
    // Normal: saldo = trabalhado - jornada
    saldo=trabMins-jornadaDia;
    // Aplicar tolerância
    if(Math.abs(saldo)<=tol) saldo=0;
    extra100=0;
  }

  return{horasTrab:trabMins,intervalo:intervMins,saldo,extra100,jornadaDia};
}

// ============================================================
// AUTH
// ============================================================
function showScr(id){
  ['scrLogin','scrReg','scrForgot'].forEach(s=>{
    const e=document.getElementById(s);if(e)e.style.display=s===id?'flex':'none';
  });
  document.getElementById('mainApp').classList.remove('visible');
}
function showApp(){
  ['scrLogin','scrReg','scrForgot'].forEach(s=>{const e=document.getElementById(s);if(e)e.style.display='none';});
  document.getElementById('mainApp').classList.add('visible');
}
function toggleEye(id,btn){const i=document.getElementById(id);i.type=i.type==='password'?'text':'password';btn.textContent=i.type==='password'?'👁️':'🙈';}

async function doLogin(){
  const u=document.getElementById('liU').value.trim();
  const p=document.getElementById('liP').value;
  const err=document.getElementById('loginErr');
  err.classList.remove('show');
  if(!u||!p){err.textContent='Preencha todos os campos.';err.classList.add('show');return;}
  let user=await dbGet('users',u);
  if(!user){const all=await dbAll('users');user=all.find(x=>x.email===u);}
  if(!user){err.textContent='Usuário não encontrado.';err.classList.add('show');return;}
  const h=await hashP(p);
  if(user.password!==h){err.textContent='Senha incorreta.';err.classList.add('show');return;}
  CU=user;localStorage.setItem('psCU',user.username);
  await loadApp();toast('Bem-vindo, '+user.name.split(' ')[0]+'! 👋','✅');
}

async function doRegister(){
  const name=document.getElementById('rName').value.trim();
  const username=document.getElementById('rUser').value.trim().toLowerCase().replace(/\s/g,'');
  const email=document.getElementById('rEmail').value.trim();
  const salary=parseFloat(document.getElementById('rSal').value)||0;
  const jorn=parseInt(document.getElementById('rJorn').value)||220;
  const pass=document.getElementById('rPass').value;
  const pass2=document.getElementById('rPass2').value;
  const err=document.getElementById('regErr');const suc=document.getElementById('regOk');
  err.classList.remove('show');suc.classList.remove('show');
  if(!name||!username||!email||!pass){err.textContent='Preencha todos os campos.';err.classList.add('show');return;}
  if(pass!==pass2){err.textContent='As senhas não coincidem.';err.classList.add('show');return;}
  if(pass.length<6){err.textContent='Mínimo 6 caracteres.';err.classList.add('show');return;}
  try{
    const ex=await _origGet('users',username);
    if(ex&&ex.username!=='__fsDir__'){err.textContent='Usuário já existe.';err.classList.add('show');return;}
    const all=(await _origAll('users')).filter(u=>u.username!=='__fsDir__');
    const isFirst=all.length===0;
    const h=await hashP(pass);
    await _origPut('users',{username,name,email,password:h,salary,jornada:jorn,tolerancia:10,modo:'clt30',jornadaDiaMin:440,role:isFirst?'admin':'user',createdAt:new Date().toISOString()});
    syncToFile();
    suc.textContent='Conta criada! Redirecionando...';suc.classList.add('show');
    setTimeout(()=>showScr('scrLogin'),1400);
  }catch(e){
    err.textContent='Erro ao criar conta: '+e.message;err.classList.add('show');
    console.error('doRegister erro:',e);
  }
}

async function fgStep1(){
  const id=document.getElementById('fgId').value.trim();
  const err=document.getElementById('fgErr');const suc=document.getElementById('fgOk');
  err.classList.remove('show');suc.classList.remove('show');
  let user=await dbGet('users',id);
  if(!user){const all=await dbAll('users');user=all.find(x=>x.email===id);}
  if(!user){err.textContent='Usuário não encontrado.';err.classList.add('show');return;}
  fgTgt=user.username;
  suc.textContent='Usuário encontrado! Defina a nova senha.';suc.classList.add('show');
  document.getElementById('fgS1').style.display='none';document.getElementById('fgS2').style.display='block';
}

async function fgStep2(){
  const p=document.getElementById('fgP1').value;const p2=document.getElementById('fgP2').value;
  const err=document.getElementById('fgErr');const suc=document.getElementById('fgOk');
  err.classList.remove('show');suc.classList.remove('show');
  if(!p||p!==p2){err.textContent='As senhas não coincidem.';err.classList.add('show');return;}
  if(p.length<6){err.textContent='Mínimo 6 caracteres.';err.classList.add('show');return;}
  const user=await dbGet('users',fgTgt);
  user.password=await hashP(p);await dbPut('users',user);
  suc.textContent='Senha redefinida!';suc.classList.add('show');
  setTimeout(()=>{showScr('scrLogin');fgTgt=null;},1400);
}

function doLogout(){CU=null;localStorage.removeItem('psCU');showScr('scrLogin');document.getElementById('liU').value='';document.getElementById('liP').value='';document.getElementById('loginErr').classList.remove('show');}

// ============================================================
// LOAD APP
// ============================================================
async function loadApp(){
  document.getElementById('uName').textContent=CU.name;
  document.getElementById('uRole').textContent=CU.role==='admin'?'Administrador':'Funcionário';
  document.getElementById('uAv').textContent=CU.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  document.getElementById('admNav').style.display=CU.role==='admin'?'block':'none';
  const now=new Date();
  document.getElementById('sbPeriod').textContent=MONTHS[now.getMonth()]+' '+now.getFullYear();
  populateSels();loadLanc();renderDash();showApp();showPage('pHome');
}

function populateSels(){
  const now=new Date();const opts=[];
  for(let i=0;i<36;i++){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const ym=d.getFullYear()*100+(d.getMonth()+1);
    opts.push({ym,label:ymLabel(ym)});
  }
  ['dashMes','lMes','holMes','expI','expF','acumI','acumF'].forEach(id=>{
    const sel=document.getElementById(id);if(!sel)return;
    sel.innerHTML='';
    opts.forEach(o=>{const op=document.createElement('option');op.value=o.ym;op.textContent=o.label;sel.appendChild(op);});
  });
  // expF default = oldest
  const expF=document.getElementById('expF');
  if(expF&&expF.options.length>0)expF.value=opts[opts.length-1].ym;
  const acumF=document.getElementById('acumF');
  if(acumF&&acumF.options.length>0)acumF.value=opts[opts.length-1].ym;
}

// ============================================================
// NAVIGATION
// ============================================================
const PAGE_TITLES={pHome:'Dashboard',pLanc:'Lançamento de Ponto',pHist:'Histórico Mensal',pBanco:'Banco de Horas',pAcum:'Acumulado por Período',pHol:'Holerite',pExp:'Exportar Dados',pConf:'Configurações',pAdm:'Usuários'};
function showPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(n=>n.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelector(`[data-p="${id}"]`)?.classList.add('active');
  document.getElementById('tbTitle').textContent=PAGE_TITLES[id]||'';
  if(id==='pHome')renderDash();
  if(id==='pHist')renderHist();
  if(id==='pBanco')renderBanco();
  if(id==='pAdm')renderAdm();
  if(id==='pHol')renderHol();
  if(id==='pConf')loadConf();
}
function setTheme(t){
  document.body.setAttribute('data-theme',t);
  document.querySelectorAll('.tdot').forEach(d=>d.classList.remove('active'));
  document.querySelector(`.tdot.${t}`)?.classList.add('active');
  localStorage.setItem('psTheme',t);
}

// ============================================================
// DASHBOARD
// ============================================================
function dashSetHoje(){
  const now=new Date();
  const ymNow=now.getFullYear()*100+(now.getMonth()+1);
  const sel=document.getElementById('dashMes');
  if(sel)sel.value=ymNow;
  renderDash();
}

async function renderDash(){
  if(!CU)return;
  const now=new Date();
  const h=now.getHours();
  const gr=h<12?'Bom dia':h<18?'Boa tarde':'Boa noite';
  document.getElementById('dashGreet').textContent=`${gr}, ${CU.name.split(' ')[0]}! 👋`;
  document.getElementById('dashDate').textContent=now.toLocaleDateString('pt-BR',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

  // Usar o mês selecionado no seletor (ou mês atual)
  const ymNow=now.getFullYear()*100+(now.getMonth()+1);
  const dashSel=document.getElementById('dashMes');
  const ym=dashSel&&dashSel.value?parseInt(dashSel.value):ymNow;
  const isMesAtual=(ym===ymNow);

  const recs=await dbIdx('records','uMonth',[CU.username,ym]);
  const allRecs=await dbAll('records');
  const userRecs=allRecs.filter(r=>r.username===CU.username);

  const y=Math.floor(ym/100),m2=ym%100;
  const mesLabel=ymLabel(ym);

  // Atualizar label da tabela
  const lbl=document.getElementById('dashMesLabel');
  if(lbl)lbl.textContent=mesLabel+(isMesAtual?' (atual)':'');

  // Cálculo do mês selecionado
  let hTrab=0,hPos=0,hNeg=0,extra100=0,dias=0;
  recs.forEach(r=>{
    if(r.horasTrab>0){hTrab+=r.horasTrab;dias++;}
    if(r.saldo>0)hPos+=r.saldo;
    if(r.saldo<0)hNeg+=Math.abs(r.saldo);
    if(r.extra100>0)extra100+=r.extra100;
  });

  // Saldo de meses ANTERIORES ao mês selecionado
  const prevRecs=userRecs.filter(r=>r.ym<ym);
  let saldoAntPos=0,saldoAntNeg=0;
  prevRecs.forEach(r=>{if(r.saldo>0)saldoAntPos+=r.saldo;if(r.saldo<0)saldoAntNeg+=Math.abs(r.saldo);});
  const saldoAnt=saldoAntPos-saldoAntNeg;

  const uteis=countWeekdays(y,m2);
  const jornadaMes=(CU.jornada||220)*60;
  const debitoMes=hNeg;
  const salPH=(CU.salary||0)/(CU.jornada||220);

  document.getElementById('dHorasMes').textContent=toHM(hTrab);
  document.getElementById('dMeta').textContent=toHM(jornadaMes);
  const pct=Math.min(100,Math.round(hTrab/jornadaMes*100));
  document.getElementById('dProg').style.width=pct+'%';

  const debEl=document.getElementById('dDebitoMes');
  debEl.textContent=toHM(debitoMes);
  debEl.className='sv '+(debitoMes>0?'sn':'sp');
  document.getElementById('dDebitoSub').textContent=debitoMes>0?'Horas em falta':'Sem débito ✓';

  const sAntEl=document.getElementById('dSaldoAnt');
  sAntEl.textContent=(saldoAnt>=0?'+':'')+toHM(saldoAnt);
  sAntEl.className='sv '+(saldoAnt>=0?'sp':'sn');
  document.getElementById('dSaldoAntSub').textContent=(saldoAnt>=0?'Crédito':'Débito')+' meses anteriores';

  const hPosEl=document.getElementById('dHorasPos');
  hPosEl.textContent='+'+toHM(hPos);

  const saldoMes=hPos-hNeg;
  const sMEl=document.getElementById('dBancoMes');
  sMEl.textContent=(saldoMes>=0?'+':'')+toHM(saldoMes);
  sMEl.className='sv '+(saldoMes>=0?'sp':'sn');
  document.getElementById('dBancoSub').textContent=`${toHM(hPos)} − ${toHM(hNeg)}`;

  const saldoTotalBanco=saldoAnt+saldoMes;
  const sTotEl=document.getElementById('dSaldoTotal');
  sTotEl.textContent=(saldoTotalBanco>=0?'+':'')+toHM(saldoTotalBanco);
  sTotEl.className='sv '+(saldoTotalBanco>=0?'sp':'sn');
  document.getElementById('dSaldoTotalSub').textContent=(saldoTotalBanco>=0?'Crédito':'Débito')+' total atual do banco';

  document.getElementById('dExtras').textContent=toHM(extra100);
  const valorExt=extra100/60*salPH*2;
  document.getElementById('dExtrasVal').textContent='R$ '+valorExt.toFixed(2).replace('.',',');

  document.getElementById('dDias').textContent=dias;
  document.getElementById('dDiasSub').textContent=`de ${uteis} úteis — ${mesLabel}`;

  // Registros do mês selecionado, ordenados pelo dia (mais recente primeiro)
  // Mostra TODOS os dias do mês (a rolagem interna do .tw cuida do resto)
  const sorted=[...recs].filter(r=>r.entrada||r.obs).sort((a,b)=>b.date.localeCompare(a.date));
  const tbody=document.getElementById('dashRec');
  if(!sorted.length){
    tbody.innerHTML=`<tr><td colspan="10" style="text-align:center;padding:22px;color:var(--text2)">Nenhum lançamento em ${mesLabel}</td></tr>`;
    return;
  }
  tbody.innerHTML=sorted.map(r=>{
    const sc=r.saldo>0?'color:var(--green)':r.saldo<0?'color:var(--red)':'';
    const badge=r.obs?`<span class="badge by" style="font-size:10px">${r.obs}</span>`:'Normal';
    const tipo=r.extra100>0?'<span class="badge bg">EXTRA</span>':'';
    return`<tr>
      <td>${r.date.split('-')[2]}/${r.date.split('-')[1]}</td>
      <td>${dayName(r.date).substring(0,3)}</td>
      <td>${badge}${tipo}</td>
      <td>${r.entrada||'—'}</td><td>${r.saidaIntervalo||'—'}</td><td>${r.retorno||'—'}</td><td>${r.saida||'—'}</td>
      <td>${r.horasTrab?toHM(r.horasTrab):'—'}</td>
      <td style="${sc}">${r.saldo!==0&&r.saldo!==undefined?(r.saldo>0?'+':'')+toHM(r.saldo):'—'}</td>
      <td style="font-size:11px;color:var(--text2);max-width:160px;white-space:normal">${r.nota||'—'}</td>
    </tr>`;
  }).join('');
}

// ============================================================
// LANÇAMENTO
// ============================================================
async function loadLanc(){
  const sel=document.getElementById('lMes');if(!sel||!sel.value)return;
  const ym=parseInt(sel.value);
  const y=Math.floor(ym/100),m=ym%100;
  const days=new Date(y,m,0).getDate();
  document.getElementById('lMesLabel').textContent=ymLabel(ym);

  const dsel=document.getElementById('lDia');dsel.innerHTML='';
  for(let d=1;d<=days;d++){
    const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dn=dayName(ds);
    const op=document.createElement('option');
    op.value=ds;
    op.textContent=`${d} - ${dn.charAt(0).toUpperCase()+dn.slice(1)}${isWE(ds)?' 🔴':''}`;
    dsel.appendChild(op);
  }
  const today=new Date();
  if(today.getFullYear()===y&&today.getMonth()+1===m){
    dsel.value=`${y}-${String(m).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  }
  await loadDayRec();
  await renderLancTable(ym);
}

async function loadDayRec(){
  const dateStr=document.getElementById('lDia')?.value;if(!dateStr)return;
  const dn=dayName(dateStr);
  document.getElementById('lSemana').textContent=dn.charAt(0).toUpperCase()+dn.slice(1);
  const tc=document.getElementById('lTipoChip');
  if(isWE(dateStr)){tc.textContent=isSunday(dateStr)?'☀️ Domingo':'📅 Sábado';tc.style.display='inline-flex';}
  else{tc.style.display='none';}
  document.getElementById('lDayInfo').style.display='flex';

  const recs=await dbIdx('records','uDate',[CU.username,dateStr]);
  const rec=recs[0];
  ['tE','tSI','tR','tS'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('lObs').value='';
  document.getElementById('lNota').value='';
  document.getElementById('lCalc').style.display='none';

  if(rec){
    if(rec.entrada)document.getElementById('tE').value=rec.entrada;
    if(rec.saidaIntervalo)document.getElementById('tSI').value=rec.saidaIntervalo;
    if(rec.retorno)document.getElementById('tR').value=rec.retorno;
    if(rec.saida)document.getElementById('tS').value=rec.saida;
    if(rec.obs)document.getElementById('lObs').value=rec.obs;
    if(rec.nota)document.getElementById('lNota').value=rec.nota;
    updateCalc();
  }
  // Se fim de semana e sem obs, sugerir EXTRA_100
  if(isWE(dateStr)&&!rec?.obs){
    document.getElementById('lObs').value='EXTRA_100';
    onObsChange();
  }
}

function onObsChange(){
  updateCalc();
  const obs=document.getElementById('lObs').value;
  const noHor=['FERIADO','FOLGA','ATESTADO','FERIAS','ABONO','FALTA'];
  // não esconder horários, usuário pode querer preencher mesmo assim
}

function updateCalc(){
  const e=document.getElementById('tE').value;
  const s=document.getElementById('tS').value;
  if(!e&&!s){document.getElementById('lCalc').style.display='none';return;}
  const dateStr=document.getElementById('lDia')?.value;
  if(!dateStr)return;
  const obs=document.getElementById('lObs').value;
  const rec={date:dateStr,obs,entrada:e,saidaIntervalo:document.getElementById('tSI').value,retorno:document.getElementById('tR').value,saida:s};
  const c=calcRec(rec);

  document.getElementById('cHoras').textContent=toHM(c.horasTrab);
  document.getElementById('cInt').textContent=toHM(c.intervalo);
  document.getElementById('cJorn').textContent=toHM(c.jornadaDia);
  const sel=document.getElementById('cSaldo');
  sel.textContent=toHMPos(c.saldo);
  sel.style.color=c.saldo>=0?'var(--green)':'var(--red)';

  const extBox=document.getElementById('cExtraBox');
  if(c.extra100>0){extBox.style.display='block';document.getElementById('cExtra').textContent=toHM(c.extra100);}
  else extBox.style.display='none';

  // Aviso tolerância
  const avEl=document.getElementById('cAviso');
  if(obs===''&&e&&s){
    const raw=c.horasTrab-c.jornadaDia;
    if(raw!==0&&c.saldo===0){
      avEl.textContent=`⚡ Diferença de ${toHM(Math.abs(raw))} dentro da tolerância de ${CU.tolerancia||10}min → saldo = 0`;
      avEl.style.display='block';
    } else avEl.style.display='none';
  } else avEl.style.display='none';

  document.getElementById('lCalc').style.display='block';
}

async function saveLanc(){
  try{
    const dateStr=document.getElementById('lDia')?.value;
    if(!dateStr){toast('Selecione um dia.','⚠️');return;}
    const obs=document.getElementById('lObs').value;
    const nota=document.getElementById('lNota').value;
    const e=document.getElementById('tE').value;
    const si=document.getElementById('tSI').value;
    const r2=document.getElementById('tR').value;
    const s=document.getElementById('tS').value;
    const obsNaoTrab=['FERIADO','FOLGA','ATESTADO','FERIAS','ABONO'];
    if(!obsNaoTrab.includes(obs)&&obs!=='FALTA'&&(!e||!s)){
      toast('Informe a entrada e saída, ou selecione um tipo de ausência.','⚠️');return;
    }
    const ym=getYM(dateStr);
    const recCalc={date:dateStr,obs,entrada:e,saidaIntervalo:si,retorno:r2,saida:s};
    const c=calcRec(recCalc);
    const existingArr=await dbIdx('records','uDate',[CU.username,dateStr]);
    const existing=(existingArr&&existingArr.length>0)?existingArr[0]:null;
    const obj={
      ...(existing||{}),
      username:CU.username,date:dateStr,ym,obs,nota,
      entrada:e,saidaIntervalo:si,retorno:r2,saida:s,
      horasTrab:c.horasTrab,saldo:c.saldo,intervalo:c.intervalo,extra100:c.extra100,jornadaDia:c.jornadaDia
    };
    await dbPut('records',obj);
    toast('Registro salvo! ✔️','💾');
    await renderLancTable(ym);
    renderDash();
  }catch(err){
    console.error('Erro ao salvar:',err);
    toast('Erro ao salvar: '+err.message,'❌');
  }
}

function clearLanc(){
  ['tE','tSI','tR','tS'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('lObs').value='';document.getElementById('lNota').value='';
  document.getElementById('lCalc').style.display='none';
}

async function renderLancTable(ym){
  const recs=await dbIdx('records','uMonth',[CU.username,ym]);
  const recMap={};recs.forEach(r=>recMap[r.date]=r);
  const y=Math.floor(ym/100),m=ym%100;
  const days=new Date(y,m,0).getDate();
  const tbody=document.getElementById('lTable');tbody.innerHTML='';
  let totTrab=0,totPos=0,totNeg=0,totExt=0;

  for(let d=1;d<=days;d++){
    const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dn=dayName(ds);const we=isWE(ds);
    const rec=recMap[ds];
    const tr=document.createElement('tr');
    if(we)tr.classList.add('weekend-row');
    if(rec?.obs==='FERIADO')tr.classList.add('holiday-row');
    if(rec?.extra100>0)tr.classList.add('extra-row');

    const jd=rec?rec.jornadaDia:(we?0:getJornadaDia(ds,''));
    if(rec?.horasTrab)totTrab+=rec.horasTrab;
    if(rec?.saldo>0)totPos+=rec.saldo;
    if(rec?.saldo<0)totNeg+=Math.abs(rec.saldo);
    if(rec?.extra100>0)totExt+=rec.extra100;

    const obsBadge=rec?.obs?`<span class="badge by" style="font-size:9px">${rec.obs}</span>`:(we?`<span class="badge br" style="font-size:9px">FDS</span>`:'');
    const positivo=rec?.saldo>0?toHM(rec.saldo):'—';
    const negativo=rec?.saldo<0?toHM(Math.abs(rec.saldo)):'—';
    const ext100=rec?.extra100>0?`<span style="color:var(--green);font-weight:700">${toHM(rec.extra100)}</span>`:'—';

    tr.innerHTML=`
      <td><strong>${d}</strong></td>
      <td>${dn.substring(0,3)}</td>
      <td>${obsBadge}</td>
      <td>${rec?.entrada||'—'}</td><td>${rec?.saidaIntervalo||'—'}</td><td>${rec?.retorno||'—'}</td><td>${rec?.saida||'—'}</td>
      <td>${rec?.horasTrab?toHM(rec.horasTrab):'—'}</td>
      <td style="color:var(--text2);font-size:11px">${toHM(jd)}</td>
      <td style="color:var(--green)">${positivo}</td>
      <td style="color:var(--red)">${negativo}</td>
      <td>${ext100}</td>
      <td style="white-space:nowrap">
        <button class="bs bo" style="padding:3px 8px;font-size:10px" onclick="jumpDay('${ds}')">✏️</button>
        ${rec?`<button class="bs bd" style="padding:3px 8px;font-size:10px;margin-left:3px" onclick="delRec('${ds}',${ym})">🗑️</button>`:''}
      </td>`;
    tbody.appendChild(tr);
  }
  const totDiv=document.getElementById('lTotais');
  totDiv.innerHTML=`
    <span><strong>Trabalhado:</strong> ${toHM(totTrab)}</span>
    <span style="color:var(--green)"><strong>Positivas:</strong> +${toHM(totPos)}</span>
    <span style="color:var(--red)"><strong>Negativas:</strong> -${toHM(totNeg)}</span>
    <span style="color:var(--green)"><strong>Extra 100%:</strong> ${toHM(totExt)}</span>
    <span style="color:${(totPos-totNeg)>=0?'var(--green)':'var(--red)'}"><strong>Saldo Mês:</strong> ${toHMPos(totPos-totNeg)}</span>`;
}

async function jumpDay(ds){
  const ym=getYM(ds);
  document.getElementById('lMes').value=ym;
  await loadLanc();
  document.getElementById('lDia').value=ds;
  await loadDayRec();
  window.scrollTo(0,0);
}

async function delRec(ds,ym){
  if(!confirm('Excluir registro de '+ds+'?'))return;
  const recs=await dbIdx('records','uDate',[CU.username,ds]);
  if(recs[0]?.id)await dbDel('records',recs[0].id);
  toast('Registro excluído.','🗑️');
  await renderLancTable(ym);renderDash();
}

// ============================================================
// HISTÓRICO
// ============================================================
async function renderHist(){
  const all=await dbAll('records');
  const ur=all.filter(r=>r.username===CU.username);
  const f=(document.getElementById('histSearch')?.value||'').toLowerCase();
  const byM={};ur.forEach(r=>{if(!byM[r.ym])byM[r.ym]=[];byM[r.ym].push(r);});
  const months=Object.keys(byM).sort((a,b)=>b-a);
  const tbody=document.getElementById('histBody');
  if(!months.length){tbody.innerHTML='<tr><td colspan="9" style="text-align:center;padding:22px;color:var(--text2)">Nenhum registro</td></tr>';return;}
  tbody.innerHTML=months.filter(ym=>ymLabel(parseInt(ym)).toLowerCase().includes(f)).map(ym=>{
    const rs=byM[ym];const y=Math.floor(ym/100),m=ym%100;
    const uteis=countWeekdays(y,m);
    const jornMes=(CU.jornada||220)*60;
    const dias=rs.filter(r=>r.horasTrab>0).length;
    const trab=rs.reduce((s,r)=>s+(r.horasTrab||0),0);
    const pos=rs.reduce((s,r)=>s+(r.saldo>0?r.saldo:0),0);
    const neg=rs.reduce((s,r)=>s+(r.saldo<0?Math.abs(r.saldo):0),0);
    const ext=rs.reduce((s,r)=>s+(r.extra100||0),0);
    const saldo=pos-neg;
    return`<tr>
      <td><strong>${ymLabel(parseInt(ym))}</strong></td>
      <td>${uteis}</td><td>${dias}</td>
      <td>${toHM(trab)}</td>
      <td style="color:var(--text2)">${toHM(jornMes)}</td>
      <td style="color:var(--green)">${toHM(pos)}</td>
      <td style="color:var(--red)">${toHM(neg)}</td>
      <td style="color:var(--yellow)">${toHM(ext)}</td>
      <td style="color:${saldo>=0?'var(--green)':'var(--red)'};font-weight:700">${saldo>=0?'+':''}${toHM(saldo)}</td>
    </tr>`;
  }).join('')||'<tr><td colspan="9" style="text-align:center;padding:22px;color:var(--text2)">Sem resultados</td></tr>';
}

// ============================================================
// BANCO DE HORAS
// ============================================================
async function renderBanco(){
  const all=await dbAll('records');
  const ur=all.filter(r=>r.username===CU.username);
  const byM={};ur.forEach(r=>{if(!byM[r.ym])byM[r.ym]=[];byM[r.ym].push(r);});
  const months=Object.keys(byM).sort((a,b)=>a-b);
  let totCred=0,totDeb=0,acum=0;
  const salPH=(CU.salary||0)/(CU.jornada||220);

  // Dias úteis e de repouso para DSR — Súmula 172 TST
  // Repouso = domingos + feriados (não trabalhados OU trabalhados como EXTRA_100_FERIADO)
  //         + domingos trabalhados como EXTRA_100_DOMINGO
  // Sábado é dia útil em jornada 44h/6 dias.
  // recMap: mapa date→record para identificar obs do dia
  // Retorna {uteis, repouso} garantindo uteis + repouso = total dias do mês
  function calcDiasDSR(y,m,recMap){
    const days=new Date(y,m,0).getDate();
    let uteis=0,repouso=0;
    for(let d=1;d<=days;d++){
      const w=new Date(y,m-1,d).getDay();
      const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const obs=recMap[ds]?.obs||'';
      // É repouso se:
      // - domingo (w===0) com qualquer obs, OU
      // - feriado não trabalhado (obs=FERIADO), OU
      // - feriado trabalhado (obs=EXTRA_100_FERIADO)
      // Não é repouso: sábado, dia útil normal, EXTRA_100 (dia útil trabalhado como extra)
      const eFeriado=obs==='FERIADO'||obs==='EXTRA_100_FERIADO';
      const eDomingo=w===0; // inclui EXTRA_100_DOMINGO pois o dia continua sendo domingo
      if(eDomingo||eFeriado){repouso++;}
      else{uteis++;}
    }
    return{uteis,repouso};
  }

  const rows=months.map(ym=>{
    const rs=byM[ym];
    const cred=rs.reduce((s,r)=>s+(r.saldo>0?r.saldo:0),0);
    const deb=rs.reduce((s,r)=>s+(r.saldo<0?Math.abs(r.saldo):0),0);
    const ext=rs.reduce((s,r)=>s+(r.extra100||0),0);
    const saldoMes=cred-deb;acum+=saldoMes;totCred+=cred;totDeb+=deb;
    const vExt=ext/60*salPH*2;

    // DSR sobre a hora extra 100% — fórmula CLT (Súmula 172 TST):
    // (valor total das horas extras no mês ÷ dias úteis do mês) × dias de repouso (domingos+feriados)
    const y=Math.floor(ym/100),m=ym%100;
    const recMap={};rs.forEach(r=>recMap[r.date]=r);
    const {uteis:dUteis,repouso:dRepouso}=calcDiasDSR(y,m,recMap);
    const dsrExt=dUteis>0?(vExt/dUteis)*dRepouso:0;
    const totalExtDsr=vExt+dsrExt;

    // Valor do banco de horas ao valor da hora a 60% — sobre o SALDO ACUMULADO do banco
    // (crédito: recebível a 60% se convertido em pagamento; débito: mesma base, apenas informativo)
    return`<tr>
      <td><strong>${ymLabel(parseInt(ym))}</strong></td>
      <td style="color:var(--green)">${toHM(cred)}</td>
      <td style="color:var(--red)">${toHM(deb)}</td>
      <td style="color:${saldoMes>=0?'var(--green)':'var(--red)'}">${saldoMes>=0?'+':''}${toHM(saldoMes)}</td>
      <td style="color:${acum>=0?'var(--green)':'var(--red)'};font-weight:700">${acum>=0?'+':''}${toHM(acum)}</td>
      <td style="color:var(--yellow)">${toHM(ext)}</td>
      <td style="color:var(--yellow)">R$ ${vExt.toFixed(2).replace('.',',')}</td>
      <td style="color:var(--yellow)">${ext>0?'R$ '+dsrExt.toFixed(2).replace('.',','):'—'}</td>
      <td style="color:var(--yellow);font-weight:700">${ext>0?'R$ '+totalExtDsr.toFixed(2).replace('.',','):'—'}</td>
    </tr>`;
  });

  document.getElementById('bBody').innerHTML=rows.join('')||'<tr><td colspan="9" style="text-align:center;padding:22px;color:var(--text2)">Sem registros</td></tr>';
  const saldoTotal=totCred-totDeb;
  document.getElementById('bTotal').textContent=(saldoTotal>=0?'+':'')+toHM(saldoTotal);
  document.getElementById('bTotal').className='sv '+(saldoTotal>=0?'sp':'sn');
  document.getElementById('bTotSub').textContent=saldoTotal>=0?'Saldo credor total':'Saldo devedor total';
  document.getElementById('bCred').textContent=toHM(totCred);
  document.getElementById('bDeb').textContent=toHM(totDeb);
}

// ============================================================
// ACUMULADO POR PERÍODO
// ============================================================
function setAcumPre(){
  const n=parseInt(document.getElementById('acumPre').value);if(!n)return;
  const now=new Date();
  const ymNow=now.getFullYear()*100+(now.getMonth()+1);
  document.getElementById('acumI').value=ymNow;
  // calcular mês de n meses atrás
  const past=new Date(now.getFullYear(),now.getMonth()-(n-1),1);
  const ymPast=past.getFullYear()*100+(past.getMonth()+1);
  document.getElementById('acumF').value=ymPast;
}

async function calcAcum(){
  const ymI=parseInt(document.getElementById('acumI').value);
  const ymF=parseInt(document.getElementById('acumF').value);
  const ymMin=Math.min(ymI,ymF),ymMax=Math.max(ymI,ymF);
  const all=await dbAll('records');
  const ur=all.filter(r=>r.username===CU.username&&r.ym>=ymMin&&r.ym<=ymMax);
  const byM={};ur.forEach(r=>{if(!byM[r.ym])byM[r.ym]=[];byM[r.ym].push(r);});
  const months=Object.keys(byM).sort((a,b)=>a-b);

  const salPH=(CU.salary||0)/(CU.jornada||220);
  let totTrab=0,totCred=0,totDeb=0,totExt=0,acum=0;

  const rows=months.map(ym=>{
    const rs=byM[ym];
    const trab=rs.reduce((s,r)=>s+(r.horasTrab||0),0);
    const cred=rs.reduce((s,r)=>s+(r.saldo>0?r.saldo:0),0);
    const deb=rs.reduce((s,r)=>s+(r.saldo<0?Math.abs(r.saldo):0),0);
    const ext=rs.reduce((s,r)=>s+(r.extra100||0),0);
    const sM=cred-deb;acum+=sM;
    totTrab+=trab;totCred+=cred;totDeb+=deb;totExt+=ext;
    return`<tr>
      <td><strong>${ymLabel(parseInt(ym))}</strong></td>
      <td>${toHM(trab)}</td>
      <td style="color:var(--green)">${toHM(cred)}</td>
      <td style="color:var(--red)">${toHM(deb)}</td>
      <td style="color:${sM>=0?'var(--green)':'var(--red)'}">${sM>=0?'+':''}${toHM(sM)}</td>
      <td style="color:var(--yellow)">${toHM(ext)}</td>
      <td style="color:${acum>=0?'var(--green)':'var(--red)'};font-weight:700">${acum>=0?'+':''}${toHM(acum)}</td>
    </tr>`;
  });

  document.getElementById('acumBody').innerHTML=rows.join('')||'<tr><td colspan="7" style="text-align:center;padding:22px;color:var(--text2)">Nenhum dado no período</td></tr>';
  document.getElementById('acumLabel').textContent=`${ymLabel(ymMin)} → ${ymLabel(ymMax)}`;

  const saldoFinal=totCred-totDeb;
  const vExt=totExt/60*salPH*2;
  // Banco de horas: pagamento = hora normal + 60% adicional = salPH × 1,6
  // Desconto por débito: valor da hora normal = salPH × 1,0
  const vBanco=saldoFinal>=0?(saldoFinal/60*salPH*1.6):(saldoFinal/60*salPH);
  const vBancoAbs=Math.abs(vBanco);

  document.getElementById('acumStats').innerHTML=`
    <div class="sc"><div class="sl">Total Trabalhado</div><div class="sv sa">${toHM(totTrab)}</div></div>
    <div class="sc"><div class="sl">Horas Positivas</div><div class="sv sp">${toHM(totCred)}</div></div>
    <div class="sc"><div class="sl">Horas Negativas</div><div class="sv sn">${toHM(totDeb)}</div></div>
    <div class="sc"><div class="sl">Saldo Final Período</div><div class="sv ${saldoFinal>=0?'sp':'sn'}">${saldoFinal>=0?'+':''}${toHM(saldoFinal)}</div></div>
    <div class="sc"><div class="sl">Extra 100% (h)</div><div class="sv" style="color:var(--yellow)">${toHM(totExt)}</div></div>`;

  document.getElementById('acumFin').innerHTML=`
    <div class="ct">💰 Resumo Financeiro do Período</div>
    <div class="irow"><span class="ik">Valor Extras 100%</span><span class="iv" style="color:var(--yellow)">R$ ${vExt.toFixed(2).replace('.',',')}</span></div>
    <div class="irow"><span class="ik">Saldo Banco de Horas</span><span class="iv ${saldoFinal>=0?'sp':'sn'}">${saldoFinal>=0?'+':''}${toHM(saldoFinal)}</span></div>
    <div class="irow">
      <span class="ik">${saldoFinal>=0?'Valor Banco (hora + 60% adicional)':'Valor a Descontar (hora normal)'}</span>
      <span class="iv" style="color:${saldoFinal>=0?'var(--green)':'var(--red)'}">${saldoFinal>=0?'+ ':'- '}R$ ${vBancoAbs.toFixed(2).replace('.',',')}</span>
    </div>
    <div class="irow"><span class="ik">Observação</span><span class="iv" style="font-size:12px;color:var(--text2)">${saldoFinal>=0?'Crédito: hora normal + 60% de adicional (CLT Art. 59)':'Débito descontado pelo valor da hora normal'}</span></div>`;

  document.getElementById('acumResult').style.display='block';
}

// ============================================================
// HOLERITE
// ============================================================
function hRow(label,value,color){
  const c=color||(value<0?'var(--red)':'var(--text)');
  const prefix=value<0?'- ':'';const abs=Math.abs(value);
  return`<div class="irow"><span class="ik">${label}</span><span class="iv" style="color:${c}">${prefix}R$ ${abs.toFixed(2).replace('.',',')}</span></div>`;
}

async function renderHol(){
  const sel=document.getElementById('holMes');if(!sel||!sel.value)return;
  const ym=parseInt(sel.value);
  const recs=await dbIdx('records','uMonth',[CU.username,ym]);
  const jorn=CU.jornada||220;const sal=CU.salary||0;const salPH=sal/jorn;

  let trab=0,ext100=0,bCred=0,bDeb=0,dias=0;
  recs.forEach(r=>{
    if(r.horasTrab>0){trab+=r.horasTrab;dias++;}
    if(r.extra100>0)ext100+=r.extra100;
    if(r.saldo>0)bCred+=r.saldo;
    if(r.saldo<0)bDeb+=Math.abs(r.saldo);
  });

  const vExt=ext100/60*salPH*2;
  const totalBruto=sal+vExt;
  const inss=calcINSS(totalBruto);
  const fgts=totalBruto*0.08;
  const irrf=calcIRRF(totalBruto-inss);
  const liq=totalBruto-inss-irrf;
  const y=Math.floor(ym/100),m=ym%100;
  const saldoBanco=bCred-bDeb;

  document.getElementById('holContent').innerHTML=`
  <div style="max-width:640px;margin:0 auto">
    <div style="text-align:center;padding-bottom:18px;border-bottom:2px solid var(--border);margin-bottom:20px">
      <div style="font-size:10px;color:var(--text2);font-weight:700;letter-spacing:1px;text-transform:uppercase">Demonstrativo de Pagamento</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px">${CU.name}</div>
      <div style="font-size:13px;color:var(--text2);margin-top:2px">${MONTHS[m-1]}/${y} • ${dias} dias trabalhados • Competência: ${String(m).padStart(2,'0')}/${y}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:18px">
      <div><div style="font-size:10px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">PROVENTOS</div>
        ${hRow('Salário Base',sal,'var(--text)')}
        ${ext100>0?hRow(`Extras 100% (${toHM(ext100)})`,vExt,'var(--green)'):''}
      </div>
      <div><div style="font-size:10px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">DESCONTOS</div>
        ${hRow('INSS',-inss)}
        ${irrf>0?hRow('IRRF',-irrf):''}
      </div>
    </div>
    ${saldoBanco!==0?`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--rsm);padding:12px 16px;margin-bottom:14px">
      <div style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">📋 BANCO DE HORAS (Informativo)</div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:13px">
        <span><span style="color:var(--text2)">Créditos:</span> <span style="color:var(--green);font-weight:600">${toHM(bCred)}</span></span>
        <span><span style="color:var(--text2)">Débitos:</span> <span style="color:var(--red);font-weight:600">${toHM(bDeb)}</span></span>
        <span><span style="color:var(--text2)">Saldo do Mês:</span> <span style="color:${saldoBanco>=0?'var(--green)':'var(--red)'};font-weight:700">${saldoBanco>=0?'+':''}${toHM(saldoBanco)}</span></span>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:6px">⚠️ Banco de horas não impacta o pagamento — saldo é compensado em folgas conforme acordo coletivo.</div>
    </div>`:''}
    
    <div style="background:var(--surface2);border-radius:var(--rsm);padding:16px;border:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <div><div style="font-size:10px;color:var(--text2);font-weight:700;text-transform:uppercase">Total Bruto</div><div style="font-size:18px;font-weight:800">R$ ${totalBruto.toFixed(2).replace('.',',')}</div></div>
        <div><div style="font-size:10px;color:var(--text2);font-weight:700;text-transform:uppercase">FGTS (8%)</div><div style="font-size:16px;font-weight:700;color:var(--accent)">R$ ${fgts.toFixed(2).replace('.',',')}</div></div>
        <div style="text-align:right"><div style="font-size:10px;color:var(--green);font-weight:700;text-transform:uppercase">LÍQUIDO A RECEBER</div><div style="font-size:26px;font-weight:800;color:var(--green)">R$ ${liq.toFixed(2).replace('.',',')}</div></div>
      </div>
    </div>
    <div style="margin-top:14px;padding:10px;background:var(--surface2);border-radius:var(--rsm);font-size:10px;color:var(--text3);text-align:center">Documento gerado pelo PontoSmart em ${new Date().toLocaleDateString('pt-BR')} — Meramente informativo.</div>
  </div>`;
}

function calcINSS(b){
  // Tabela 2024 simplificada
  if(b<=1412)return b*0.075;
  if(b<=2666.68)return b*0.09;
  if(b<=4000.03)return b*0.12;
  if(b<=7786.02)return b*0.14;
  return 908.86;
}
function calcIRRF(b){
  // Tabela 2024 simplificada
  if(b<=2259.20)return 0;
  if(b<=2826.65)return b*0.075-169.44;
  if(b<=3751.05)return b*0.15-381.44;
  if(b<=4664.68)return b*0.225-662.77;
  return b*0.275-896;
}

// ============================================================
// EXPORT
// ============================================================
async function getExpRecs(){
  const ymI=parseInt(document.getElementById('expI')?.value||0);
  const ymF=parseInt(document.getElementById('expF')?.value||999999);
  const all=await dbAll('records');
  return all.filter(r=>r.username===CU.username&&r.ym>=Math.min(ymI,ymF)&&r.ym<=Math.max(ymI,ymF)).sort((a,b)=>a.date.localeCompare(b.date));
}

async function exportExcel(){
  const recs=await getExpRecs();
  if(!recs.length){toast('Nenhum registro no período.','⚠️');return;}
  const wb=XLSX.utils.book_new();
  const byM={};recs.forEach(r=>{if(!byM[r.ym])byM[r.ym]=[];byM[r.ym].push(r);});

  // --- Estilos reutilizáveis ---
  const stHdrBlue={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{fgColor:{rgb:'3F63CC'}},alignment:{horizontal:'center',vertical:'center',wrapText:true},border:{bottom:{style:'thin',color:{rgb:'FFFFFF'}}}};
  const stHdrGreen={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{fgColor:{rgb:'1A7A4A'}},alignment:{horizontal:'center',vertical:'center'}};
  const stTotal={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{fgColor:{rgb:'1A1D35'}},alignment:{horizontal:'center'}};
  const stTotalLabel={font:{bold:true,color:{rgb:'FFFFFF'},sz:10},fill:{fgColor:{rgb:'1A1D35'}},alignment:{horizontal:'right'}};
  const stNormal={alignment:{horizontal:'center',vertical:'center'},border:{bottom:{style:'thin',color:{rgb:'E0E4F0'}}}};
  const stPos={font:{color:{rgb:'127A3E'},bold:true},alignment:{horizontal:'center'},border:{bottom:{style:'thin',color:{rgb:'E0E4F0'}}}};
  const stNeg={font:{color:{rgb:'CC2233'},bold:true},alignment:{horizontal:'center'},border:{bottom:{style:'thin',color:{rgb:'E0E4F0'}}}};
  const stYel={font:{color:{rgb:'996600'},bold:true},alignment:{horizontal:'center'},border:{bottom:{style:'thin',color:{rgb:'E0E4F0'}}}};
  const stWE={font:{color:{rgb:'AA4444'}},fill:{fgColor:{rgb:'FFF0F0'}},alignment:{horizontal:'center'}};
  const stTitle={font:{bold:true,color:{rgb:'1A1D35'},sz:14},alignment:{horizontal:'left'}};
  const stSubt={font:{color:{rgb:'555880'},sz:10},alignment:{horizontal:'left'}};

  function cell(v,s){return{v,t:typeof v==='number'?'n':'s',s};}
  function applyStyles(ws,styles){Object.entries(styles).forEach(([addr,s])=>{if(ws[addr])ws[addr].s=s;else ws[addr]={v:'',t:'s',s};});}

  // ================================================
  // ABA RESUMO
  // ================================================
  const sumData=[];
  // Linha 1: Título
  sumData.push([`FOLHA DE PONTO — ${CU.name}`,'','','','','','']);
  sumData.push([`Emitido em: ${new Date().toLocaleDateString('pt-BR')}  |  Jornada: ${CU.jornada||220}h/mês  |  Salário: R$ ${(CU.salary||0).toFixed(2).replace('.',',')}`,
    '','','','','','']);
  sumData.push(['','','','','','','']);
  // Cabeçalho
  sumData.push(['MÊS','DIAS TRAB.','H. TRABALHADAS','H. POSITIVAS','H. NEGATIVAS','EXTRA 100%','SALDO BANCO']);
  const sumHdrRow=sumData.length; // linha do cabeçalho (1-based = 4)
  let sumTotTrab=0,sumTotPos=0,sumTotNeg=0,sumTotExt=0;
  Object.keys(byM).sort().forEach(ym=>{
    const rs=byM[ym];
    const dias=rs.filter(r=>r.horasTrab>0).length;
    const trab=rs.reduce((s,r)=>s+(r.horasTrab||0),0);
    const pos=rs.reduce((s,r)=>s+(r.saldo>0?r.saldo:0),0);
    const neg=rs.reduce((s,r)=>s+(r.saldo<0?Math.abs(r.saldo):0),0);
    const ext=rs.reduce((s,r)=>s+(r.extra100||0),0);
    sumTotTrab+=trab;sumTotPos+=pos;sumTotNeg+=neg;sumTotExt+=ext;
    sumData.push([ymLabel(parseInt(ym)),dias,toHM(trab),'+'+toHM(pos),'-'+toHM(neg),toHM(ext),toHMPos(pos-neg)]);
  });
  sumData.push(['TOTAL GERAL','',toHM(sumTotTrab),'+'+toHM(sumTotPos),'-'+toHM(sumTotNeg),toHM(sumTotExt),toHMPos(sumTotPos-sumTotNeg)]);
  const wsSum=XLSX.utils.aoa_to_sheet(sumData);
  wsSum['!cols']=[{wch:22},{wch:13},{wch:16},{wch:14},{wch:14},{wch:12},{wch:14}];
  wsSum['!merges']=[{s:{r:0,c:0},e:{r:0,c:6}},{s:{r:1,c:0},e:{r:1,c:6}}];
  // Estilos resumo
  const sumSt={};
  sumSt['A1']=stTitle;sumSt['A2']=stSubt;
  ['A','B','C','D','E','F','G'].forEach(c=>{sumSt[`${c}${sumHdrRow}`]=stHdrBlue;});
  for(let r=sumHdrRow+1;r<sumData.length;r++){
    const rowData=sumData[r-1];const saldo=rowData[6]||'';
    sumSt[`A${r}`]={font:{bold:true},alignment:{horizontal:'left'}};
    ['B','C'].forEach(c=>sumSt[`${c}${r}`]=stNormal);
    sumSt[`D${r}`]={...stPos};sumSt[`E${r}`]={...stNeg};
    sumSt[`F${r}`]={...stYel};
    sumSt[`G${r}`]={font:{bold:true,color:{rgb:String(saldo).startsWith('-')?'CC2233':'127A3E'}},alignment:{horizontal:'center'}};
  }
  // linha total
  const totR=sumData.length;
  ['A','B','C','D','E','F','G'].forEach(c=>sumSt[`${c}${totR}`]=stTotal);
  applyStyles(wsSum,sumSt);
  XLSX.utils.book_append_sheet(wb,wsSum,'Resumo');

  // ================================================
  // ABA POR MÊS
  // ================================================
  Object.keys(byM).sort().forEach(ym=>{
    const mRecs=byM[ym];const y=Math.floor(ym/100),m=ym%100;
    const days=new Date(y,m,0).getDate();const recMap={};mRecs.forEach(r=>recMap[r.date]=r);
    const data=[];
    // Cabeçalho da aba
    data.push([`FOLHA DE PONTO — ${ymLabel(parseInt(ym)).toUpperCase()}  |  ${CU.name}`,'','','','','','','','','','','','','']);
    data.push([`Jornada: ${CU.jornada||220}h/mês  |  Salário: R$ ${(CU.salary||0).toFixed(2).replace('.',',')}  |  Gerado em: ${new Date().toLocaleDateString('pt-BR')}`,
      '','','','','','','','','','','','','']);
    data.push(['','','','','','','','','','','','','','']);
    const cols=['DIA','DATA','SEMANA','TIPO/OBS','ENTRADA','S.INTERVALO','RETORNO','SAÍDA','JORNADA DIA','TRABALHADO','H. POSITIVAS','H. NEGATIVAS','EXTRA 100%','NOTAS'];
    data.push(cols);
    const hdrRow=data.length;
    let totTrab=0,totPos=0,totNeg=0,totExt=0;
    for(let d=1;d<=days;d++){
      const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const r=recMap[ds];const dn=dayName(ds);const we=isWE(ds);
      const jd=r&&r.jornadaDia!==undefined?r.jornadaDia:(we?0:getJornadaDia(ds,''));
      if(r?.horasTrab)totTrab+=r.horasTrab;
      if(r?.saldo>0)totPos+=r.saldo;
      if(r?.saldo<0)totNeg+=Math.abs(r.saldo);
      if(r?.extra100)totExt+=r.extra100;
      const dnCap=dn.charAt(0).toUpperCase()+dn.slice(1);
      data.push([d,ds,dnCap,r?.obs||'',r?.entrada||'',r?.saidaIntervalo||'',r?.retorno||'',r?.saida||'',
        toHM(jd),r?.horasTrab?toHM(r.horasTrab):'',
        r?.saldo>0?'+'+toHM(r.saldo):'',r?.saldo<0?'-'+toHM(Math.abs(r.saldo)):'',
        r?.extra100?toHM(r.extra100):'',r?.nota||'']);
    }
    data.push(['','','','TOTAIS DO MÊS','','','','','',toHM(totTrab),'+'+toHM(totPos),'-'+toHM(totNeg),toHM(totExt),'Saldo: '+toHMPos(totPos-totNeg)]);

    const ws=XLSX.utils.aoa_to_sheet(data);
    ws['!cols']=[{wch:5},{wch:12},{wch:12},{wch:14},{wch:9},{wch:12},{wch:9},{wch:9},{wch:11},{wch:11},{wch:12},{wch:12},{wch:12},{wch:22}];
    ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:13}},{s:{r:1,c:0},e:{r:1,c:13}}];

    // Estilos por aba mensal
    const mSt={};
    mSt['A1']={...stTitle};mSt['A2']={...stSubt};
    const colLetters=['A','B','C','D','E','F','G','H','I','J','K','L','M','N'];
    colLetters.forEach(c=>mSt[`${c}${hdrRow}`]=stHdrBlue);
    for(let d=1;d<=days;d++){
      const row=hdrRow+d;
      const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const we=isWE(ds);const isSun=isSunday(ds);
      colLetters.forEach((c,i)=>{
        const addr=`${c}${row}`;
        if(we){mSt[addr]={...stWE};if(isSun)mSt[addr].font={...mSt[addr].font,bold:true};}
        else mSt[addr]={...stNormal};
        if(c==='K')mSt[addr]={...stPos};
        if(c==='L')mSt[addr]={...stNeg};
        if(c==='M')mSt[addr]={...stYel};
      });
    }
    // Linha de totais
    const totRow=hdrRow+days+1;
    colLetters.forEach((c,i)=>{
      mSt[`${c}${totRow}`]=i<3?stTotalLabel:{...stTotal};
    });
    mSt[`K${totRow}`]={...stTotal,font:{...stTotal.font,color:{rgb:'22C87E'}}};
    mSt[`L${totRow}`]={...stTotal,font:{...stTotal.font,color:{rgb:'FF5C6A'}}};
    mSt[`M${totRow}`]={...stTotal,font:{...stTotal.font,color:{rgb:'FFB830'}}};
    applyStyles(ws,mSt);
    XLSX.utils.book_append_sheet(wb,ws,ymLabel(parseInt(ym)).replace(' / ','_').substring(0,31));
  });

  XLSX.writeFile(wb,`FolhaPonto_${CU.username}_${new Date().toISOString().split('T')[0]}.xlsx`);
  toast('Excel exportado com formatação!','📊');
}

async function exportPDF(){
  const recs=await getExpRecs();
  if(!recs.length){toast('Nenhum registro no período.','⚠️');return;}
  const{jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  const byM={};recs.forEach(r=>{if(!byM[r.ym])byM[r.ym]=[];byM[r.ym].push(r);});
  let first=true;
  Object.keys(byM).sort().forEach(ym=>{
    if(!first)doc.addPage();first=false;
    const mRecs=byM[ym];const y=Math.floor(ym/100),m=ym%100;
    const days=new Date(y,m,0).getDate();const recMap={};mRecs.forEach(r=>recMap[r.date]=r);
    doc.setFontSize(14);doc.setFont(undefined,'bold');
    doc.text('FOLHA DE PONTO — '+ymLabel(parseInt(ym)).toUpperCase(),14,15);
    doc.setFontSize(9);doc.setFont(undefined,'normal');
    doc.text(`Funcionário: ${CU.name}  |  Jornada: ${CU.jornada||220}h/mês  |  Salário: R$ ${(CU.salary||0).toFixed(2).replace('.',',')}`,14,22);
    const uteis=countWeekdays(y,m);
    const jDia=Math.round((CU.jornada||220)*60/(CU.modo==='fixo22'?22:uteis));
    doc.text(`Dias úteis: ${uteis}  |  Jornada diária: ${toHM(jDia)}  |  Gerado em: ${new Date().toLocaleDateString('pt-BR')}`,14,27);
    const rows=[];
    for(let d=1;d<=days;d++){
      const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const r=recMap[ds];const dn=dayName(ds);
      const saldo=r?.saldo!==undefined?((r.saldo>0?'+':'')+toHM(r.saldo)):'—';
      rows.push([d,ds,dn.substring(0,3),r?.obs||'',r?.entrada||'—',r?.saidaIntervalo||'—',r?.retorno||'—',r?.saida||'—',r?.horasTrab?toHM(r.horasTrab):'—',saldo,r?.extra100?toHM(r.extra100):'—']);
    }
    doc.autoTable({
      head:[['#','Data','Sem','Obs','Entrada','S.Int.','Ret.','Saída','Trabalhado','Saldo','Extra%']],
      body:rows,startY:31,
      styles:{fontSize:7,cellPadding:1.5},
      headStyles:{fillColor:[79,124,255],textColor:255},
      alternateRowStyles:{fillColor:[242,244,255]},
      didParseCell:d=>{
        if(d.section==='body'){const v=String(d.cell.raw);
          if(v.startsWith('+'))d.cell.styles.textColor=[34,168,100];
          if(v.startsWith('-')&&v.length>3)d.cell.styles.textColor=[200,60,70];
        }
      }
    });
    // Totais no rodapé
    const yf=doc.lastAutoTable.finalY+4;
    const pos=mRecs.reduce((s,r)=>s+(r.saldo>0?r.saldo:0),0);
    const neg=mRecs.reduce((s,r)=>s+(r.saldo<0?Math.abs(r.saldo):0),0);
    const ext=mRecs.reduce((s,r)=>s+(r.extra100||0),0);
    doc.setFontSize(8);doc.setFont(undefined,'bold');
    doc.text(`Totais: Trabalhado: ${toHM(mRecs.reduce((s,r)=>s+(r.horasTrab||0),0))}  |  Positivas: +${toHM(pos)}  |  Negativas: -${toHM(neg)}  |  Extra 100%: ${toHM(ext)}  |  Saldo: ${pos-neg>=0?'+':''}${toHM(pos-neg)}`,14,yf);
  });
  doc.save(`FolhaPonto_${CU.username}_${new Date().toISOString().split('T')[0]}.pdf`);
  toast('PDF exportado!','📄');
}

async function exportHolPDF(){
  const sel=document.getElementById('holMes');
  const ym=sel?parseInt(sel.value):parseInt(document.getElementById('expI').value);
  const recs=await dbIdx('records','uMonth',[CU.username,ym]);
  const jorn=CU.jornada||220;const sal=CU.salary||0;const salPH=sal/jorn;
  let trab=0,ext100=0,bCred=0,bDeb=0,dias=0;
  recs.forEach(r=>{if(r.horasTrab>0){trab+=r.horasTrab;dias++;}if(r.extra100>0)ext100+=r.extra100;if(r.saldo>0)bCred+=r.saldo;if(r.saldo<0)bDeb+=Math.abs(r.saldo);});
  const vExt=ext100/60*salPH*2,vBCred=bCred/60*salPH*1.6,vBDeb=bDeb/60*salPH;
  const bruto=sal+vExt+vBCred-vBDeb;
  const inss=calcINSS(bruto),irrf=calcIRRF(bruto-inss),fgts=bruto*0.08,liq=bruto-inss-irrf;
  const y=Math.floor(ym/100),m=ym%100;
  const{jsPDF}=window.jspdf;const doc=new jsPDF({unit:'mm',format:'a4'});
  doc.setFillColor(79,124,255);doc.rect(0,0,210,38,'F');
  doc.setTextColor(255,255,255);doc.setFontSize(18);doc.setFont(undefined,'bold');
  doc.text('DEMONSTRATIVO DE PAGAMENTO',14,16);
  doc.setFontSize(10);doc.setFont(undefined,'normal');
  doc.text(`${CU.name}  —  ${MONTHS[m-1].toUpperCase()}/${y}`,14,24);
  doc.text(`${dias} dias trabalhados  |  Jornada: ${jorn}h/mês  |  Salário base: R$ ${sal.toFixed(2).replace('.',',')}`,14,31);
  doc.setTextColor(30,30,30);let y2=50;
  const row=(k,v,c)=>{doc.setFontSize(10);doc.setFont(undefined,'normal');doc.setTextColor(80,80,100);doc.text(k,18,y2);if(c)doc.setTextColor(...c);else doc.setTextColor(20,20,40);doc.setFont(undefined,'bold');doc.text(v,192,y2,{align:'right'});doc.setTextColor(20,20,40);y2+=8;};
  const ln=()=>{doc.setDrawColor(200,205,230);doc.line(14,y2,196,y2);y2+=3;};
  doc.setFont(undefined,'bold');doc.setFontSize(11);doc.setTextColor(34,168,100);doc.text('PROVENTOS',14,y2);y2+=6;ln();
  row('Salário Base','R$ '+sal.toFixed(2).replace('.',','));
  if(vExt>0)row(`Horas Extras 100% (${toHM(ext100)})`,'R$ '+vExt.toFixed(2).replace('.',','),[34,168,100]);
  if(vBCred>0)row(`Banco de Horas 60% (${toHM(bCred)})`,'R$ '+vBCred.toFixed(2).replace('.',','),[34,168,100]);
  y2+=2;ln();doc.setFont(undefined,'bold');doc.setFontSize(11);doc.setTextColor(220,60,70);doc.text('DESCONTOS',14,y2);y2+=6;ln();
  row('INSS',`- R$ ${inss.toFixed(2).replace('.',',')}`,null);
  if(irrf>0)row('IRRF',`- R$ ${irrf.toFixed(2).replace('.',',')}`,null);
  if(vBDeb>0)row(`Banco Horas Débito (${toHM(bDeb)})`,`- R$ ${vBDeb.toFixed(2).replace('.',',')}`,null);
  y2+=4;doc.setFillColor(245,247,255);doc.roundedRect(14,y2-4,182,44,4,4,'F');
  doc.setFontSize(10);doc.setFont(undefined,'bold');doc.setTextColor(40,40,70);
  doc.text('Total Bruto:',20,y2+6);doc.text('R$ '+bruto.toFixed(2).replace('.',','),192,y2+6,{align:'right'});
  doc.text('FGTS (8%):',20,y2+16);doc.setTextColor(79,124,255);doc.text('R$ '+fgts.toFixed(2).replace('.',','),192,y2+16,{align:'right'});
  doc.setFontSize(14);doc.setTextColor(34,168,100);
  doc.text('LÍQUIDO A RECEBER:',20,y2+30);doc.text('R$ '+liq.toFixed(2).replace('.',','),192,y2+30,{align:'right'});
  doc.setTextColor(160,160,180);doc.setFontSize(8);doc.setFont(undefined,'normal');
  doc.text('Documento meramente informativo. Gerado pelo PontoSmart em '+new Date().toLocaleDateString('pt-BR'),14,285);
  doc.save(`Holerite_${CU.username}_${MONTHS[m-1]}_${y}.pdf`);
  toast('Holerite PDF exportado!','💰');
}

async function exportBancoPDF(){
  const all=await dbAll('records');const ur=all.filter(r=>r.username===CU.username);
  const byM={};ur.forEach(r=>{if(!byM[r.ym])byM[r.ym]=[];byM[r.ym].push(r);});
  const months=Object.keys(byM).sort();
  const salPH=(CU.salary||0)/(CU.jornada||220);
  const{jsPDF}=window.jspdf;const doc=new jsPDF({unit:'mm',format:'a4'});
  doc.setFontSize(16);doc.setFont(undefined,'bold');doc.text('EXTRATO — BANCO DE HORAS',14,16);
  doc.setFontSize(10);doc.setFont(undefined,'normal');doc.text('Funcionário: '+CU.name+'  |  Gerado em: '+new Date().toLocaleDateString('pt-BR'),14,23);
  let acum=0;
  const rows=months.map(ym=>{
    const rs=byM[ym];
    const cred=rs.reduce((s,r)=>s+(r.saldo>0?r.saldo:0),0);
    const deb=rs.reduce((s,r)=>s+(r.saldo<0?Math.abs(r.saldo):0),0);
    const ext=rs.reduce((s,r)=>s+(r.extra100||0),0);
    const sM=cred-deb;acum+=sM;
    const vExt=ext/60*salPH*2;
    const vBanco=acum>=0?(acum/60*salPH*0.6):(acum/60*salPH);
    return[ymLabel(parseInt(ym)),toHM(cred),toHM(deb),(sM>=0?'+':'')+''+toHM(sM),(acum>=0?'+':'')+toHM(acum),toHM(ext),'R$ '+vExt.toFixed(2).replace('.',','),'R$ '+Math.abs(vBanco).toFixed(2).replace('.',',')];
  });
  doc.autoTable({head:[['Mês','Créditos','Débitos','Saldo Mês','Saldo Acum.','Extra 100%','Valor Extra','Valor Banco']],body:rows,startY:28,styles:{fontSize:8},headStyles:{fillColor:[79,124,255]}});
  doc.save(`BancoHoras_${CU.username}_${new Date().toISOString().split('T')[0]}.pdf`);
  toast('Banco de Horas PDF exportado!','🏦');
}

// ============================================================
// BACKUP & RESTORE
// ============================================================
async function backupJSON(){
  const users=await dbAll('users');
  const records=await dbAll('records');
  // Remove passwords from non-current users for privacy (keep own)
  const safeUsers=users.map(u=>u.username===CU.username?u:{...u,password:'[protected]'});
  const blob=new Blob([JSON.stringify({version:2,exportedAt:new Date().toISOString(),username:CU.username,users:safeUsers,records},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');
  a.href=url;a.download=`PontoSmart_Backup_${CU.username}_${new Date().toISOString().split('T')[0]}.json`;a.click();
  URL.revokeObjectURL(url);
  toast('Backup salvo no computador!','⬇️');
}

async function restoreJSON(event){
  const file=event.target.files[0];if(!file)return;
  const text=await file.text();
  let data;
  try{data=JSON.parse(text);}catch(e){toast('Arquivo inválido.','❌');return;}
  if(!data.records||!Array.isArray(data.records)){toast('Formato de backup inválido.','❌');return;}
  if(!confirm(`Restaurar ${data.records.length} registros de "${data.username || 'backup'}"? Dados existentes do mesmo usuário serão substituídos.`))return;
  let count=0;
  for(const rec of data.records){
    if(rec.username===CU.username){
      const{id,...rest}=rec;// remove old id, let auto-increment handle it
      // check if exists by date
      const ex=(await dbIdx('records','uDate',[CU.username,rec.date]))[0];
      if(ex)await dbPut('records',{...rest,id:ex.id});
      else await dbPut('records',rest);
      count++;
    }
  }
  toast(`Restaurados ${count} registros!`,'⬆️');
  loadLanc();renderDash();
  event.target.value='';
}

// ============================================================
// CONFIG
// ============================================================
function onModoChange(){
  const modo=document.getElementById('cfgModo').value;
  const manRow=document.getElementById('cfgManualRow');
  const info=document.getElementById('cfgModoInfo');
  manRow.style.display=modo==='manual'?'grid':'none';
  const msgs={
    'clt30':'ℹ️ <strong>CLT 7h20m:</strong> 220h ÷ 30 = 7h20m por dia. Padrão para jornada 44h/semana com sábado incluso.',
    'div22':'ℹ️ <strong>Fixo ÷ 22:</strong> 220h ÷ 22 = 10h por dia. Só recomendado se sua empresa usa essa base.',
    'uteis':'ℹ️ <strong>Dias úteis do mês:</strong> Divide pelo número real de dias úteis (seg-sex). Varia mês a mês.',
    'manual':'ℹ️ <strong>Manual:</strong> Você define exatamente quantas horas precisa trabalhar por dia.'
  };
  info.innerHTML=msgs[modo]||'';
}
function loadConf(){
  if(!CU)return;
  document.getElementById('cfgName').value=CU.name||'';
  document.getElementById('cfgEmail').value=CU.email||'';
  document.getElementById('cfgSal').value=CU.salary||'';
  document.getElementById('cfgJorn').value=CU.jornada||220;
  document.getElementById('cfgTol').value=CU.tolerancia||10;
  const modo=CU.modo||'clt30';
  document.getElementById('cfgModo').value=modo;
  // Converter jornadaDiaMin para HH:MM
  const jdMin=CU.jornadaDiaMin||440;
  const jdH=String(Math.floor(jdMin/60)).padStart(2,'0');
  const jdM=String(jdMin%60).padStart(2,'0');
  document.getElementById('cfgJornDia').value=`${jdH}:${jdM}`;
  onModoChange();
}
async function saveConf(){
  CU.name=document.getElementById('cfgName').value.trim();
  CU.email=document.getElementById('cfgEmail').value.trim();
  CU.salary=parseFloat(document.getElementById('cfgSal').value)||0;
  CU.jornada=parseInt(document.getElementById('cfgJorn').value)||220;
  CU.tolerancia=parseInt(document.getElementById('cfgTol').value)||10;
  CU.modo=document.getElementById('cfgModo').value||'clt30';
  // Salvar jornada manual em minutos
  const jdStr=document.getElementById('cfgJornDia').value||'07:20';
  const[jdH,jdM]=jdStr.split(':').map(Number);
  CU.jornadaDiaMin=(jdH||0)*60+(jdM||0)||440;
  await dbPut('users',CU);
  document.getElementById('uName').textContent=CU.name;
  document.getElementById('uAv').textContent=CU.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  toast('Configurações salvas! Recalcule os registros existentes se necessário.','✅');
}
async function changePass(){
  const at=document.getElementById('pAt').value;
  const no=document.getElementById('pNo').value;
  const no2=document.getElementById('pNo2').value;
  if(!at||!no||!no2){toast('Preencha todos os campos.','⚠️');return;}
  if(no!==no2){toast('As senhas não coincidem.','⚠️');return;}
  if(no.length<6){toast('Mínimo 6 caracteres.','⚠️');return;}
  const h=await hashP(at);
  if(CU.password!==h){toast('Senha atual incorreta.','❌');return;}
  CU.password=await hashP(no);await dbPut('users',CU);
  toast('Senha alterada!','🔒');
  ['pAt','pNo','pNo2'].forEach(id=>document.getElementById(id).value='');
}

// ============================================================
// ADMIN
// ============================================================
async function renderAdm(){
  if(CU.role!=='admin')return;
  updateFsStatus();
  const users=(await dbAll('users')).filter(u=>u.username!=='__fsDir__');
  document.getElementById('admBody').innerHTML=users.map(u=>`<tr>
    <td>${u.name}</td><td>${u.username}</td><td>${u.email}</td>
    <td>R$ ${(u.salary||0).toFixed(2).replace('.',',')}</td>
    <td>${u.jornada||220}h</td>
    <td><span class="badge ${u.role==='admin'?'bb':'bg'}">${u.role==='admin'?'Admin':'Funcionário'}</span></td>
    <td>${u.username!==CU.username?`<button class="bs bd" style="font-size:10px" onclick="delUser('${u.username}')">🗑️</button>`:'<span style="color:var(--text3);font-size:11px">Você</span>'}</td>
  </tr>`).join('');
}
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
async function addUserAdm(){
  const n=document.getElementById('auN').value.trim(),u=document.getElementById('auU').value.trim().toLowerCase(),e=document.getElementById('auE').value.trim();
  const s=parseFloat(document.getElementById('auS').value)||0,j=parseInt(document.getElementById('auJ').value)||220,p=document.getElementById('auP').value,r=document.getElementById('auR').value;
  if(!n||!u||!e||!p){toast('Preencha todos os campos.','⚠️');return;}
  if(await dbGet('users',u)){toast('Usuário já existe.','⚠️');return;}
  const h=await hashP(p);
  await dbPut('users',{username:u,name:n,email:e,password:h,salary:s,jornada:j,tolerancia:10,modo:'clt30',jornadaDiaMin:440,role:r,createdAt:new Date().toISOString()});
  closeModal('mAddU');toast('Usuário criado!','✅');renderAdm();
}
async function delUser(u){
  if(!confirm('Excluir usuário '+u+' e todos os registros?'))return;
  const all=await dbAll('records');
  for(const r of all.filter(r=>r.username===u))await dbDel('records',r.id);
  await dbDel('users',u);toast('Usuário excluído.','🗑️');renderAdm();
}

// ============================================================
// TOAST
// ============================================================
function toast(msg,icon='ℹ️'){
  const t=document.createElement('div');t.className='toast';
  t.innerHTML=`<span style="font-size:16px">${icon}</span> ${msg}`;
  document.getElementById('toastC').appendChild(t);
  setTimeout(()=>t.remove(),3500);
}

// ============================================================
// INIT
// ============================================================
async function resetDB(){
  if(!confirm('Isso vai limpar o banco de dados local e recarregar. Seus dados serão perdidos. Continuar?'))return;
  indexedDB.deleteDatabase('PontoSmart');
  setTimeout(()=>location.reload(),500);
}

document.addEventListener('DOMContentLoaded',async()=>{
  await initDB();
  const th=localStorage.getItem('psTheme')||'dark';setTheme(th);
  // Modal close on backdrop
  document.querySelectorAll('.mo').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open');}));
  // Restaurar handle de pasta salvo
  await fsRestore();
  // Auto-login
  const saved=localStorage.getItem('psCU');
  if(saved){const u=await _origGet('users',saved);if(u&&u.username!=='__fsDir__'){CU=u;await loadApp();return;}}
  const all=(await _origAll('users')).filter(u=>u.username!=='__fsDir__');
  if(!all.length){showScr('scrReg');toast('Bem-vindo! Crie sua conta para começar.','👋');}
  else showScr('scrLogin');
});