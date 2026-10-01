const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {Server,app,until}=require('./fake-supabase.cjs');
const root=path.resolve(__dirname,'..');
function script(a,file){vm.runInContext(fs.readFileSync(path.join(root,'assets/js',file),'utf8'),a.context,{filename:file});}
for(const page of ['dashboard','assets','markets','trade','history','demo','settings']) {
 test(page+' limits initial reads to the current page and current profile',async t=>{
  const s=new Server(),u=s.seed('one@test.invalid',true);s.seed('other@test.invalid');
  const a=app(s,u,{page:page+'.html'});t.after(()=>a.close());await a.DB.ready;
  assert.equal(Object.keys(a.A.readJSON('bb_accounts',{})).length,1,'an ordinary page fetched all admin-visible accounts');
  const calls=s.calls.filter(c=>c.op==='select');
  assert.equal(calls.filter(c=>c.table==='profiles').length,1,'profile downloaded twice');
  if(page!=='assets')assert.equal(calls.filter(c=>c.table.startsWith('support_')).length,0,'unrelated chat downloaded');
  if(['markets','demo'].includes(page))assert.equal(calls.filter(c=>c.table==='request_rows').length,0,'unrelated history downloaded');
 });
}
test('a slow read does not cause a repeating refresh loop',async t=>{
 const s=new Server(),u=s.seed('slow@test.invalid'),a=app(s,u,{page:'markets.html'});t.after(()=>a.close());await a.DB.ready;
 const from=a.client.from;let release;
 a.client.from=table=>{const q=from(table);if(table==='profiles')q.then=(yes,no)=>new Promise(r=>{release=()=>r(q.run());}).then(yes,no);return q;};
 const p=a.DB.refresh();await until(()=>!!release);
 a.DB.refresh();a.DB.refresh();a.DB.refresh();release();await p;
 const count=s.calls.length;await new Promise(r=>setTimeout(r,180));
 assert.equal(s.calls.length,count,'duplicate refresh calls scheduled another whole refresh');
});
test('server-managed trades never pay from a browser quote or profit-mode flag',async t=>{
 const s=new Server(),u=s.seed('real@test.invalid'),a=app(s,u);t.after(()=>a.close());await a.DB.ready;
 a.DB.mirror.bb_cash_balance=800;a.DB.mirror.bb_accounts[u.id].cash=800;a.DB.mirror.bb_accounts[u.id].profitMode=true;
 const p={id:'one',amt:200,profit:60,status:'Active',dir:'UP',entryPrice:10,startTime:Date.now()-60000,dur:15};
 a.DB.mirror.bb_trade_positions=[p];script(a,'trades.js');
 assert.equal(a.window.BitbaseTrades.settleOne('real',p,20),null);
 assert.equal((await a.window.BitbaseTrades.settleDue('real',()=>20)).length,0);
 assert.equal(a.A.cash(),800);assert.equal(a.DB.hasPending(),false);
});
test('a stale profile writer cannot overwrite a settlement credit',async t=>{
 const s=new Server(),u=s.seed('stale@test.invalid'),a=app(s,u);t.after(()=>a.close());await a.DB.ready;
 const p=s.tables.profiles[0];p.cash=1060;p.updated=s.time();
 await assert.rejects(a.DB.saveProfile({cash:800}),/changed in another session/);
 assert.equal(p.cash,1060);
});
test('uncertain placement retry reuses the same ID and has no optimistic debit',async t=>{
 const s=new Server(),u=s.seed('retry@test.invalid'),a=app(s,u);t.after(()=>a.close());await a.DB.ready;
 a.DB.mirror.bb_accounts[u.id].cash=1000;
 let attempts=[];a.DB.tradeRpc=async(name,args)=>{attempts.push({...args});if(attempts.length===1)throw new Error('Network lost');return {contractId:args.p_id,status:'Active'};};
 script(a,'server-trades.js');const place=a.window.BitbaseServerTrades.place;
 await assert.rejects(place({sym:'BTC',dir:'UP',amt:200,dur:60}),/Network/);
 assert.equal(a.A.cash(),1000);
 await assert.rejects(place({sym:'ETH',dir:'UP',amt:200,dur:60}),/previous order/);
 await place({sym:'BTC',dir:'UP',amt:200,dur:60});assert.equal(attempts[0].p_id,attempts[1].p_id);
 assert.deepEqual(Object.keys(attempts[0]).sort(),['p_amount','p_direction','p_duration','p_id','p_symbol']);
});
test('a backend rejection clears pending intent and never falls back to browser trading',async t=>{
 const s=new Server(),u=s.seed('rejected@test.invalid'),a=app(s,u);t.after(()=>a.close());await a.DB.ready;
 a.DB.tradeRpc=async()=>{throw {message:'Insufficient balance',code:'P0001'};};script(a,'server-trades.js');
 await assert.rejects(a.window.BitbaseServerTrades.place({sym:'BTC',dir:'DOWN',amt:200,dur:60}),e=>e.message==='Insufficient balance');
 assert.equal(a.window.sessionStorage.getItem('bb_pending_contract:'+u.id),null);
 assert.equal(a.A.readJSON('bb_trade_positions',[]).length,0);
});
test('an acknowledged trade paints its server balance without queuing any profile write',async t=>{
 const s=new Server(),u=s.seed('ack@test.invalid'),a=app(s,u);t.after(()=>a.close());await a.DB.ready;
 a.client.rpc=async()=>({data:{id:'T-one',contractId:'uuid',status:'Active',amt:200,balance:800,balanceVersion:s.time()},error:null});
 const r=await a.DB.tradeRpc('bb_place_contract',{});assert.equal(r.status,'Active');assert.equal(a.A.cash(),800);assert.equal(a.DB.hasPending(),false);
 assert.equal(s.calls.filter(c=>c.op==='update').length,0);
});
test('a remote settlement updates a result panel through an event exactly once',async t=>{
 const s=new Server(),u=s.seed('observe@test.invalid'),a=app(s,u);t.after(()=>a.close());await a.DB.ready;
 a.DB.mirror.bb_trade_positions=[{id:'T-one',status:'Active',startTime:Date.now(),dur:60}];script(a,'trades.js');await Promise.resolve();
 const events=[];a.window.addEventListener('bitbase:settled',e=>events.push(e.detail));
 a.DB.mirror.bb_trade_positions=[];a.DB.mirror.bb_trades_history=[{id:'T-one',status:'Won',net:60,mode:'real'}];
 a.window.dispatchEvent(new CustomEvent('bitbase:data'));a.window.dispatchEvent(new CustomEvent('bitbase:data'));
 assert.equal(events.length,1);assert.equal(events[0].net,60);
});
test('demo positions and history persist without sharing real trade rows',async t=>{
 const s=new Server(),u=s.seed('demo@test.invalid'),a=app(s,u,{page:'demo.html'});t.after(()=>a.close());await a.DB.ready;
 a.A.writeJSON('bb_demo_trades_pos',[{id:'demo-one',status:'Active'}]);a.A.writeJSON('bb_demo_trades_hist',[{id:'demo-one',status:'Active'}]);await a.A.flush();
 const b=app(s,u,{page:'demo.html'});t.after(()=>b.close());await b.DB.ready;
 assert.equal(b.A.readJSON('bb_demo_trades_pos',[]).length,1);assert.equal(b.A.readJSON('bb_demo_trades_hist',[]).length,1);assert.equal(s.tables.request_rows.length,0);
});
