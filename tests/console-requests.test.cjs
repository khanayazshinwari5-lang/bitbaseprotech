const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {Server,app,until}=require('./fake-supabase.cjs');
const root=path.resolve(__dirname,'..');
const PNG='data:image/png;base64,'+'A'.repeat(2000);

/* A picture is several hundred kilobytes. request_rows is re-read by every page
   on a timer, so an attachment left inside it made every visitor download every
   picture anybody had ever uploaded - which is what made the reads time out and
   the pages crawl. The attachment travels on its own settings row instead. */
test('an uploaded picture is stored apart from the request it belongs to',async t=>{
  const s=new Server(),admin=s.seed('admin@example.test',true),a=app(s,admin);
  t.after(()=>a.close());
  await a.DB.ready;
  a.A.activity.add('deposit',{amount:500,coin:'USDT',usd:500,network:'ERC20',
    proof:{name:'receipt.jpg',type:'image/jpeg',size:4000000,at:1,data:PNG},status:'pending'});
  await a.A.flush();

  const row=s.tables.request_rows.find(r=>r.kind==='deposit');
  assert.ok(row,'no deposit row was written');
  assert.ok(!JSON.stringify(row.data).includes('base64'),'the picture is still inside request_rows.data');
  assert.equal(row.data.proof.name,'receipt.jpg','the file name was lost');
  assert.match(row.data.proof.ref,/^bb_doc_/,'no reference to the attachment');
  assert.ok(!JSON.stringify(s.tables.request_rows).includes('base64'),'a picture leaked into the list read');

  const bag=await a.DB.attachment(row.data.proof.ref);
  assert.equal(bag.proof.data,PNG,'the attachment cannot be loaded back on demand');
});

test('a request read elsewhere still serves its picture',async t=>{
  const s=new Server(),admin=s.seed('admin2@example.test',true),a=app(s,admin);
  t.after(()=>a.close());
  await a.DB.ready;
  a.A.activity.add('deposit',{amount:10,coin:'USDT',usd:10,network:'ERC20',
    proof:{name:'r.png',type:'image/png',size:10,at:1,data:PNG},status:'pending'});
  await a.A.flush();
  const row=s.tables.request_rows.find(r=>r.kind==='deposit');

  const b=app(s,admin);
  t.after(()=>b.close());
  await b.DB.ready;await b.DB.refresh();
  const seen=(b.A.readJSON('bb_deposit_requests',[])||[])[0];
  assert.ok(seen,'the request was not mirrored');
  assert.ok(!seen.proof.data,'the mirror is carrying the bytes again');
  assert.equal((await b.DB.attachment(seen.proof.ref)).proof.data,PNG);
});

/* supabase-js cancels in-flight work by aborting its own signal. Reporting that
   as a failure showed users "changes could not be saved" when nothing was wrong. */
test('a cancelled read is not reported as a data failure, a real one is',async t=>{
  const s=new Server(),admin=s.seed('admin3@example.test',true),a=app(s,admin);
  t.after(()=>a.close());
  await a.DB.ready;
  s.fail={table:'profiles',message:'signal is aborted without reason'};
  await assert.rejects(a.DB.refresh(),e=>/aborted/.test(e.message||e));
  assert.equal(a.DB.error(),null,'a cancelled read was reported as a failure');
  s.fail={table:'profiles',message:'connection refused'};
  await assert.rejects(a.DB.refresh(),e=>/refused/.test(e.message||e));
  assert.match(String(a.DB.error()),/connection refused/,'a real failure was swallowed');
});

/* Where the money goes is console configuration. Earlier the app invented a
   placeholder address and wrote it into the shared store: customers were shown
   an address nobody controlled, the admin's real one was overwritten in their
   view, and the refused write raised an error on the deposit dialog. */
test('a deposit address belongs to the console: customers read it and cannot write it',async t=>{
  const s=new Server(),admin=s.seed('admin4@example.test',true),a=app(s,admin);
  t.after(()=>a.close());
  await a.DB.ready;
  a.A.writeJSON('bb_deposit_addresses',{BTC:{address:'bc1qADMINADDRESS',network:'Bitcoin',qr:'data:image/png;base64,QR'}});
  await a.A.flush();

  const cust=s.seed('payer@example.test'),c=app(s,cust);
  t.after(()=>c.close());
  await c.DB.ready;
  const map=c.A.readJSON('bb_deposit_addresses',{});
  assert.equal(map.BTC.address,'bc1qADMINADDRESS','the customer cannot read the deposit configuration');
  assert.equal(map.BTC.network,'Bitcoin','the console network was lost');

  c.A.writeJSON('bb_deposit_addresses',{BTC:{address:'bc1qMINE'}});
  await c.A.flush().catch(()=>{});
  await new Promise(r=>setTimeout(r,60));
  const stored=s.tables.app_settings.find(r=>r.key==='deposit_addresses');
  assert.equal(stored.value.BTC.address,'bc1qADMINADDRESS','a customer overwrote the deposit address');
});

test('the deposit dialog shows the address the console set, and invents none',async t=>{
  const s=new Server(),cust=s.seed('dial@example.test');
  const admin=s.seed('admin5@example.test',true),a=app(s,admin);
  t.after(()=>a.close());await a.DB.ready;
  a.A.writeJSON('bb_deposit_addresses',{BTC:{address:'bc1qSETBYADMIN',network:'Bitcoin'}});
  await a.A.flush();

  const c=app(s,cust);
  t.after(()=>c.close());
  await c.DB.ready;
  const nodes={};
  const html=fs.readFileSync(path.join(root,'assets.html'),'utf8');
  for(const m of html.matchAll(/\bid="([^"]+)"/g)){
    const e=new EventTarget();
    Object.assign(e,{value:'',checked:false,disabled:false,type:'text',style:{},textContent:'',innerHTML:'',
      classList:{add(){},remove(){},toggle(){},contains(){return false;}},setAttribute(){},focus(){},
      // Rows are queried inside a table body, so every node needs the pair.
      querySelector(){return null;},querySelectorAll(){return[];},
      appendChild(){},remove(){},click(){},closest(){return null;}});
    nodes[m[1]]=e;
  }
  nodes.depositCoinSelect.value='BTC';
  nodes.depositModal.classList.contains=()=>true;
  c.window.document.getElementById=id=>nodes[id]||null;
  // The pages resolve elements with querySelector('#id'), not getElementById,
  // and some of them scope a query to document.body.
  const byId=sel=>(sel[0]==='#'?nodes[sel.slice(1)]||null:null);
  const allById=sel=>sel[0]==='#'?(nodes[sel.slice(1)]?[nodes[sel.slice(1)]]:[]):[];
  c.window.document.querySelector=byId;
  c.window.document.querySelectorAll=allById;
  c.window.document.body.querySelector=byId;
  c.window.document.body.querySelectorAll=allById;
  c.window.BitbaseShell={mount(){return true;},esc:x=>String(x==null?'':x)};
  c.window.BitbaseFeed={coins:[],instruments:[],fmtQty:v=>String(v),fmtCompact:String,loadMarkets:async()=>[],openTickerStream(){}};
  vm.runInContext(fs.readFileSync(path.join(root,'assets/js/assets-page.js'),'utf8'),c.context,{filename:'assets-page.js'});
  await new Promise(r=>setTimeout(r,80));

  assert.equal(nodes.depositAddressText.textContent,'bc1qSETBYADMIN','the console address is not what the customer is shown');
  assert.equal(nodes.depositNetworkDisplay.textContent,'Bitcoin');
  assert.equal(nodes.depositSubmitBtn.disabled,false,'the dialog will not accept a deposit for a coin the console set');
  // Nothing was invented: the shared configuration is exactly what was saved.
  const saved=c.A.readJSON('bb_deposit_addresses',{}).BTC;
  assert.equal(saved.address,'bc1qSETBYADMIN');
  assert.equal(saved.network,'Bitcoin');
});