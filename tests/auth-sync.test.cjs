const test=require('node:test');
const assert=require('node:assert/strict');
const {Server,app,until}=require('./fake-supabase.cjs');
function fixture(t){const server=new Server();const opened=[];return {server,open(user,opts){const a=app(server,user,opts);opened.push(a);t.after(()=>a.close());return a;}};}

test('restores a v2 Supabase session and reads hydrated arrays/objects',async t=>{
  const f=fixture(t),user=f.server.seed('user@example.test');f.server.tables.profiles[0].cash=75;
  const a=f.open(user);await a.DB.ready;
  assert.equal(a.A.isAuthenticated(),true);assert.equal(a.DB.uid(),user.id);
  assert.equal(a.A.readJSON('bb_accounts',{})[user.id].email,user.email);
  assert.equal(a.A.readJSON('bb_asset_balances',{}).constructor.name,'Object');
  assert.equal(a.A.cash(),75);
  a.client.refreshToken();assert.equal(a.A.isAuthenticated(),true);
});
test('signup waits for SDK boot, creates the server profile and preserves server balances on login',async t=>{
  const f=fixture(t),a=f.open();
  const me=await a.A.register({name:'New User',email:' NEW@example.test ',password:'Pass12345',country:'au'});
  assert.equal(me.email,'new@example.test');assert.equal(f.server.tables.profiles.length,1);assert.equal(a.A.isAuthenticated(),true);
  f.server.tables.profiles[0].cash=123;f.server.tables.profiles[0].kyc_status='verified';
  await a.A.logout();await a.A.login('new@example.test','Pass12345');
  assert.equal(a.A.cash(),123);assert.equal(a.A.get('bb_kyc_status'),'verified');
  assert.equal(f.server.tables.profiles[0].cash,123);
});
test('email confirmation is a successful pending signup without a fake session',async t=>{
  const f=fixture(t);f.server.confirmEmail=true;const a=f.open();
  const result=await a.A.register({name:'Verify',email:'verify@example.test',password:'Pass12345'});
  assert.equal(result.confirmationRequired,true);assert.equal(a.A.isAuthenticated(),false);assert.equal(f.server.tables.profiles.length,1);
});
test('invalid login and failed database boot do not create browser-only accounts',async t=>{
  const f=fixture(t);f.server.seed('real@example.test');const a=f.open();
  await assert.rejects(a.A.login('real@example.test','wrong'),e=>/Incorrect/.test(e.message));
  assert.equal(a.A.isAuthenticated(),false);
  const b=f.open(null,{unavailable:true,local:{bb_uid:'stale',bb_accounts:'{"stale":{"admin":true}}'}});
  await assert.rejects(b.A.register({name:'Offline',email:'offline@example.test',password:'Pass12345'}),/unreachable/);
  assert.equal(b.A.isAuthenticated(),false);assert.equal(f.server.users.length,1);
});
test('orphaned auth accounts repair only their own profile and expose database read failures',async t=>{
  const f=fixture(t),u=f.server.seed('orphan@example.test');f.server.tables.profiles=[];
  const a=f.open(u);await a.DB.ready;assert.equal(a.A.isAuthenticated(),true);assert.equal(f.server.tables.profiles[0].admin,false);
  f.server.fail={table:'profiles',op:'select',always:true,message:'Profile policy is missing'};
  await assert.rejects(a.DB.refreshSession(),/Profile policy is missing/);
});
test('admin sees a newly registered user without manual refresh',async t=>{
  const f=fixture(t),owner=f.server.seed('admin@example.test',true),admin=f.open(owner);await admin.DB.ready;
  const customer=f.open();const me=await customer.A.register({name:'Customer',email:'customer@example.test',password:'Pass12345'});
  await until(()=>!!admin.A.readJSON('bb_accounts',{})[me.uid]);
  assert.equal(admin.A.readJSON('bb_accounts',{})[me.uid].admin,false);
});
test('all request kinds arrive in admin after flush; stale writers cannot delete unseen rows',async t=>{
  const f=fixture(t),o=f.server.seed('admin@example.test',true),u=f.server.seed('user@example.test'),v=f.server.seed('other@example.test');
  const admin=f.open(o),a=f.open(u),b=f.open(v);await Promise.all([admin.DB.ready,a.DB.ready,b.DB.ready]);
  for(const kind of ['deposit','withdrawal','borrow','kyc'])a.A.activity.add(kind,{id:'A-'+kind,amount:25,status:'pending'});
  b.A.activity.add('deposit',{id:'B-deposit',amount:10,status:'pending'});
  await Promise.all([a.A.flush(),b.A.flush()]);
  await until(()=>admin.A.readJSON('bb_deposit_requests',[]).length===2&&admin.A.readJSON('bb_kyc_requests',[]).length===1);
  assert.equal(f.server.tables.request_rows.length,5);
  const row=admin.A.readJSON('bb_deposit_requests',[]).find(x=>x.userId===u.id);row.status='approved';
  const rows=admin.A.readJSON('bb_deposit_requests',[]).map(x=>x._sid===row._sid?row:x);
  admin.A.writeJSON('bb_deposit_requests',rows);await admin.A.flush();
  await until(()=>a.A.readJSON('bb_deposit_requests',[])[0].status==='approved');
  assert.equal(f.server.tables.request_rows.filter(x=>x.kind==='deposit').length,2);
});
test('chat reaches admin and admin reply reaches the correct customer without duplicate messages',async t=>{
  const f=fixture(t),o=f.server.seed('admin@example.test',true),u=f.server.seed('user@example.test'),v=f.server.seed('other@example.test');
  const admin=f.open(o),a=f.open(u),other=f.open(v);await Promise.all([admin.DB.ready,a.DB.ready,other.DB.ready]);
  a.A.writeJSON('bb_support_threads',[{id:'local',uid:u.id,name:'User',email:u.email,status:'open',messages:[{from:'user',body:'Hello',time:Date.now()}]}]);
  await a.A.flush();await until(()=>admin.A.readJSON('bb_support_threads',[])[0]?.messages.length===1);
  const threads=admin.A.readJSON('bb_support_threads',[]);threads[0].messages.push({from:'admin',body:'How can I help?',time:Date.now()});
  admin.A.writeJSON('bb_support_threads',threads);await admin.A.flush();
  await until(()=>a.A.readJSON('bb_support_threads',[])[0]?.messages.length===2);
  assert.equal(f.server.tables.support_threads[0].user_id,u.id);
  assert.equal(other.A.readJSON('bb_support_threads',[]).length,0);
  const local=a.A.readJSON('bb_support_threads',[]);local[0].messages.push({from:'user',body:'An image',image:'data:image/png;base64,dGVzdA==',time:Date.now()});
  a.A.writeJSON('bb_support_threads',local);await a.A.flush();await a.A.flush();
  await until(()=>admin.A.readJSON('bb_support_threads',[])[0]?.messages.length===3);
  assert.equal(f.server.tables.support_messages.length,3);
});
test('lost message acknowledgement can be retried without duplicating a committed message',async t=>{
  const f=fixture(t),u=f.server.seed('user@example.test'),a=f.open(u);await a.DB.ready;
  f.server.loseReply='support_messages';
  a.A.writeJSON('bb_support_threads',[{uid:u.id,name:'User',status:'open',messages:[{from:'user',body:'Only once'}]}]);
  await assert.rejects(a.A.flush(),e=>/lost after commit/.test(e.message));
  assert.equal(a.DB.hasPending(),true);assert.equal(f.server.tables.support_messages.length,1);
  await a.A.flush();assert.equal(a.DB.hasPending(),false);assert.equal(f.server.tables.support_messages.length,1);
});
test('failed request stays queued and flush actually waits for and retries its save',async t=>{
  const f=fixture(t),u=f.server.seed('user@example.test'),a=f.open(u);await a.DB.ready;
  f.server.fail={table:'request_rows',op:'upsert',message:'Offline'};
  a.A.activity.add('deposit',{amount:9,status:'pending'});
  await assert.rejects(a.A.flush(),e=>e.message==='Offline');
  assert.equal(a.DB.hasPending(),true);assert.equal(f.server.tables.request_rows.length,0);
  await a.A.flush();assert.equal(f.server.tables.request_rows.length,1);assert.equal(a.DB.hasPending(),false);
});
test('admin account edits via writeJSON reach the correct profile; logout clears prior account data',async t=>{
  const f=fixture(t),o=f.server.seed('admin@example.test',true),u=f.server.seed('user@example.test'),a=f.open(o);await a.DB.ready;
  const accounts=a.A.readJSON('bb_accounts',{});accounts[u.id].name='Updated user';a.A.writeJSON('bb_accounts',accounts);await a.A.flush();
  assert.equal(f.server.tables.profiles.find(x=>x.id===u.id).name,'Updated user');
  await a.A.logout();assert.equal(a.A.isAuthenticated(),false);assert.equal(Object.keys(a.DB.mirror).length,0);
  await a.A.login(u.email,u.password);assert.equal(Object.keys(a.A.readJSON('bb_accounts',{})).length,1);
});
test('pagination includes users beyond the first 1,000 records',async t=>{
  const f=fixture(t),o=f.server.seed('admin@example.test',true);for(let i=0;i<1002;i++)f.server.seed('user'+i+'@example.test');
  const a=f.open(o);await a.DB.ready;assert.equal(Object.keys(a.A.readJSON('bb_accounts',{})).length,1003);
});
test('customer cannot send an admin message',async t=>{
  const f=fixture(t),u=f.server.seed('user@example.test'),a=f.open(u);await a.DB.ready;
  a.A.writeJSON('bb_support_threads',[{uid:u.id,status:'open',messages:[{from:'admin',body:'Spoofed'}]}]);
  await assert.rejects(a.A.flush(),e=>/sender rejected/.test(e.message));assert.equal(f.server.tables.support_messages.length,0);
});

test('poll fallback refreshes admin data when realtime events are unavailable',async t=>{
  const f=fixture(t),o=f.server.seed('admin@example.test',true),a=f.open(o);await a.DB.ready;
  // Allow the initial subscribed refresh to finish, then disable all event delivery.
  await new Promise(r=>setTimeout(r,100));f.server.emit=()=>{};
  a.client.channels[0].stateCallback('CLOSED');
  const u=f.server.seed('poll-only@example.test');
  // The fallback poll is deliberately slow: realtime covers the normal case in
  // milliseconds, so a fast poll only competed with the page for bandwidth.
  await until(()=>!!a.A.readJSON('bb_accounts',{})[u.id],20000);
});
test('deactivated accounts cannot complete login',async t=>{
  const f=fixture(t),u=f.server.seed('disabled@example.test');f.server.tables.profiles[0].disabled=true;
  const a=f.open();await assert.rejects(a.A.login(u.email,u.password),e=>/deactivated/.test(e.message));assert.equal(a.A.isAuthenticated(),false);
});
