// Offline contract test double. It models Supabase's v2 response shapes and
// cross-client events; it is NOT a substitute for live Postgres/RLS testing.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
class Server {
  constructor() {
    this.tables=Object.fromEntries(['profiles','request_rows','support_threads','support_messages','user_settings','app_settings','admin_log'].map(t=>[t,[]]));
    this.users=[]; this.clients=[]; this.tick=0; this.fail=null; this.loseReply=null; this.confirmEmail=false; this.calls=[];
  }
  time(){ return new Date(1700000000000+(++this.tick)*1000).toISOString(); }
  seed(email,admin=false){ const user={id:crypto.randomUUID(),email,user_metadata:{name:email.split('@')[0],country:'au'},password:'Pass12345'};this.users.push(user);this.profile(user,admin);return user; }
  profile(user,admin=false){
    let p=this.tables.profiles.find(x=>x.id===user.id);if(p)return p;
    p={id:user.id,code:String(100000+this.users.indexOf(user)),email:user.email,name:user.user_metadata.name,country:'au',cash:0,funding:0,assets:{},kyc_status:'none',created:this.time(),updated:this.time(),admin,is_owner:admin,disabled:false,perms:{}};
    this.tables.profiles.push(p);this.emit('profiles');return p;
  }
  emit(table){ for(const c of this.clients)for(const ch of c.channels)if(ch.active)for(const listener of ch.listeners)if(listener.filter.table===table)listener.cb({table,eventType:'UPDATE'}); }
  client(user=null){
    const server=this;
    const c={current:user?{user:clone(user),access_token:'test-token'}:null,channels:[],authCallbacks:[]};
    const change=(event,user)=>{c.current=user?{user:clone(user),access_token:'test-token'}:null;for(const cb of c.authCallbacks)cb(event,c.current);};
    c.auth={
      getSession:async()=>({data:{session:clone(c.current)},error:null}),
      onAuthStateChange:cb=>{c.authCallbacks.push(cb);return {data:{subscription:{unsubscribe(){}}}};},
      signInWithPassword:async({email,password})=>{const u=server.users.find(x=>x.email===email&&x.password===password);if(!u)return {data:{user:null,session:null},error:{message:'Invalid login credentials',status:400}};change('SIGNED_IN',u);return {data:{user:clone(u),session:clone(c.current)},error:null};},
      signUp:async({email,password,options})=>{
        if(server.users.some(u=>u.email===email))return {error:{message:'User already registered'}};
        const u={id:crypto.randomUUID(),email,password,user_metadata:options.data};server.users.push(u);server.profile(u);
        if(!server.confirmEmail)change('SIGNED_IN',u);
        return {data:{user:clone(u),session:server.confirmEmail?null:clone(c.current)},error:null};
      },
      signOut:async()=>{change('SIGNED_OUT',null);return {error:null};},
      updateUser:async()=>({data:{},error:null})
    };
    c.from=t=>new Query(server,c,t);
    c.rpc=async name=>{if(name!=='ensure_my_profile'||!c.current)return {error:{message:'Forbidden'}};return {data:clone(server.profile(c.current.user)),error:null};};
    c.channel=name=>{
      const ch={name,listeners:[],active:false,on(event,filter,cb){this.listeners.push({filter,cb});return this;},subscribe(cb){this.active=true;cb('SUBSCRIBED');return this;}};c.channels.push(ch);return ch;
    };
    c.removeChannel=ch=>{ch.active=false;return Promise.resolve();};
    c.refreshToken=()=>change('TOKEN_REFRESHED',c.current.user);
    this.clients.push(c);return c;
  }
}
class Query {
  constructor(s,c,t){this.s=s;this.c=c;this.t=t;this.op='select';this.filters=[];this.orders=[];this.returning=false;this.one=false;this.offset=0;this.end=Infinity;}
  select(){if(this.op!=='select')this.returning=true;return this;}
  eq(k,v){this.filters.push(r=>r[k]===v);return this;}
  in(k,v){this.filters.push(r=>v.includes(r[k]));return this;}
  order(k,opts={}){this.orders.push([k,opts.ascending!==false]);return this;}
  range(a,b){this.offset=a;this.end=b;return this;}
  limit(n){this.end=n-1;return this;}
  maybeSingle(){this.one=true;return this;}
  single(){this.one=true;this.required=true;return this;}
  insert(v){this.op='insert';this.value=v;return this;}
  upsert(v,opts={}){this.op='upsert';this.value=v;this.opts=opts;return this;}
  update(v){this.op='update';this.value=v;return this;}
  delete(){this.op='delete';return this;}
  then(resolve,reject){return Promise.resolve().then(()=>this.run()).then(resolve,reject);}
  run(){
    const s=this.s,c=this.c,t=this.t,user=c.current?.user.id,admin=!!s.tables.profiles.find(p=>p.id===user&&p.admin&&!p.disabled);
    s.calls.push({table:t,op:this.op,user});
    const error=message=>({data:null,error:{message,code:'42501'}});
    if(s.fail&&s.fail.table===t&&(!s.fail.op||s.fail.op===this.op)){const f=s.fail;if(!f.always)s.fail=null;return error(f.message||'Test connection failure');}
    const visible=r=>{
      if(!user)return false;
      if(t==='profiles')return admin||r.id===user;
      if(t==='support_messages')return admin||s.tables.support_threads.some(th=>th.id===r.thread_id&&th.user_id===user);
      if(t==='app_settings')return admin||r.key==='deposit_addresses';
      return admin||r.user_id===user;
    };
    let rows=s.tables[t].filter(r=>visible(r)&&this.filters.every(f=>f(r))),result=[];
    if(this.op==='select'){
      rows.sort((a,b)=>{for(const [k,asc] of this.orders){if(a[k]<b[k])return asc?-1:1;if(a[k]>b[k])return asc?1:-1;}return 0;});
      result=rows.slice(this.offset,this.end+1);
    }else if(this.op==='update'){
      for(const r of rows){if(t==='support_threads'&&this.value.user_id&&this.value.user_id!==r.user_id)return error('Conversation ownership cannot be changed');Object.assign(r,clone(this.value),{updated:s.time()});result.push(r);}
      if(rows.length)s.emit(t);
    }else if(this.op==='delete'){
      s.tables[t]=s.tables[t].filter(r=>!rows.includes(r));result=rows;if(rows.length)s.emit(t);
    }else{
      for(let v of (Array.isArray(this.value)?this.value:[this.value])){
        v=clone(v);
        if(t==='profiles')return error('Direct profile insertion forbidden');
        if(t==='support_messages'){
          const th=s.tables.support_threads.find(x=>x.id===v.thread_id);
          if(!th||!(v.sender==='admin'?admin:v.sender==='user'&&th.user_id===user))return error('Message sender rejected by RLS');
        }else if(!visible(v))return error('Insert rejected by RLS');
        const keys=(this.opts?.onConflict||'id').split(',');
        const old=s.tables[t].find(r=>keys.every(k=>r[k]===v[k]));
        if(old){if(this.opts?.ignoreDuplicates)continue;Object.assign(old,v,{updated:s.time()});result.push(old);continue;}
        v.id=v.id||crypto.randomUUID();v.created=v.created||s.time();v.updated=s.time();
        s.tables[t].push(v);result.push(v);
        if(t==='support_messages'){const th=s.tables.support_threads.find(x=>x.id===v.thread_id);th.updated=s.time();s.emit('support_threads');}
      }
      if(result.length)s.emit(t);
      if(s.loseReply&&s.loseReply===t){s.loseReply=null;return error('Connection lost after commit');}
    }
    if(this.one){if(this.required&&!result.length)return error('Expected a row');result=result[0]||null;}
    else if(this.op!=='select'&&!this.returning)result=null;
    return {data:clone(result),error:null};
  }
}
function storage(initial={}){const m=new Map(Object.entries(initial));return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),get length(){return m.size;},key:i=>[...m.keys()][i]};}
function element(tag){const e=new EventTarget();return Object.assign(e,{tagName:tag.toUpperCase(),style:{},children:[],classList:{add(){},remove(){},toggle(){}},setAttribute(){},appendChild(ch){this.children.push(ch);this.firstChild=this.children[0];ch.parent=this;},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},textContent:''});}
function app(server,user=null,{local={},unavailable=false}={}){
  const timers=new Set();
  const timeout=(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();timers.add(t);return t;};
  const interval=(fn,ms)=>{const t=setInterval(fn,ms);t.unref();timers.add(t);return t;};
  const window=new EventTarget(),document=new EventTarget();document.body=element('body');document.head=element('head');document.hidden=false;document.readyState='complete';document.createElement=element;
  document.getElementById=id=>{const find=e=>e.id===id?e:e.children?.map(find).find(Boolean);return find(document.body)||null;};
  const client=server.client(user);
  Object.assign(window,{window,globalThis:window,document,console:{warn(){}},crypto,CustomEvent,Event,EventTarget,AbortController,Set,TextEncoder,Uint8Array,URL,Promise,
    setTimeout:timeout,clearTimeout,setInterval:interval,clearInterval,localStorage:storage(local),sessionStorage:storage(),
    location:{origin:'https://example.test',href:'https://example.test/login.html'},
    BITBASE_CONFIG:{supabaseUrl:'https://project.test',supabaseAnonKey:'test-anon',useSupabase:true},
    supabase:{createClient(){if(unavailable)throw new Error('Service unreachable');return client;}},fetch:async()=>({ok:true})});
  const context=vm.createContext(window);
  const base=path.resolve(__dirname,'../assets/js');
  vm.runInContext(fs.readFileSync(path.join(base,'db.js'),'utf8'),context,{filename:'db.js'});
  vm.runInContext(fs.readFileSync(path.join(base,'auth.js'),'utf8'),context,{filename:'auth.js'});
  return {A:window.BitbaseAuth,DB:window.BitbaseDB,window,client,context,close(){for(const t of timers){clearTimeout(t);clearInterval(t);}for(const ch of client.channels)ch.active=false;}};
}
async function until(predicate,timeout=2500){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw new Error('Timed out waiting for cross-client update');await new Promise(r=>setTimeout(r,15));}}
module.exports={Server,app,until,clone};
