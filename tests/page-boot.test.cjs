const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {Server,app,until}=require('./fake-supabase.cjs');
const root=path.resolve(__dirname,'..');
for(const name of ['dashboard','assets-page','markets-page','history-page','settings-page','trade-page']){
  test(name+' waits for session restoration before its access gate',()=>{
    let mounted=0,boot;
    const A={KEYS:{cash:'bb_cash_balance'},whenReady(fn){boot=fn;}};
    const window={BitbaseAuth:A,BitbaseFeed:{instruments:[],coins:[]},BitbaseShell:{mount(){mounted++;return false;}}};
    window.window=window;window.document={readyState:'complete',body:{getAttribute(){return null;}}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'assets/js',name+'.js'),'utf8'),window,{filename:name+'.js'});
    assert.equal(mounted,0);assert.equal(typeof boot,'function');boot();assert.equal(mounted,1);
  });
}
function formPage(a,name){
  const html=fs.readFileSync(path.join(root,name+'.html'),'utf8'),nodes={};
  for(const match of html.matchAll(/\bid="([^"]+)"/g)){
    const e=new EventTarget();Object.assign(e,{value:'',checked:false,disabled:false,type:'text',style:{},textContent:'',classList:{add(){},remove(){},toggle(){}},setAttribute(){},querySelector(){return null;},focus(){}});nodes[match[1]]=e;
  }
  a.window.document.getElementById=id=>nodes[id]||null;
  a.window.location.replace=href=>{a.window.location.href=href;};
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  vm.runInContext(scripts.at(-1)[1],a.context,{filename:name+'.html inline form'});
  return nodes;
}
test('login form shows invalid credentials, releases the spinner, then redirects after valid login',async t=>{
  const server=new Server(),u=server.seed('user@example.test'),a=app(server);t.after(()=>a.close());await a.DB.ready;
  const n=formPage(a,'login');n.email.value=u.email;n.password.value='wrong';
  n.loginForm.dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>n.loginError.textContent.includes('Incorrect'));
  assert.equal(n.submitBtn.disabled,false);
  n.password.value=u.password;n.loginForm.dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>a.window.location.href==='dashboard.html');
  assert.equal(a.A.isAuthenticated(),true);
});
test('signup form shows confirmation success and stays on the signup page',async t=>{
  const server=new Server();server.confirmEmail=true;const a=app(server);t.after(()=>a.close());await a.DB.ready;
  const n=formPage(a,'register');n.fullName.value='Customer';n.email.value='new@example.test';n.password.value='Pass12345';n['confirm-password'].value='Pass12345';n.country.value='au';n.terms.checked=true;
  n.registerForm.dispatchEvent(new Event('submit',{cancelable:true}));
  await until(()=>n.submitSuccess.textContent.includes('Check your inbox'));
  assert.equal(n.submitBtn.disabled,false);assert.notEqual(a.window.location.href,'dashboard.html');assert.equal(server.tables.profiles.length,1);
});
