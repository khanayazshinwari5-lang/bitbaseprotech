/* Optional visual smoke test. Uses Playwright and a local HTTP server; all external services are mocked. */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.env.BITBASE_TEST_URL||'http://127.0.0.1:8091';
const output=process.env.BITBASE_QA_DIR||path.resolve(__dirname,'../../qa');
fs.mkdirSync(output,{recursive:true});
function seedBrowser(){
 const user={id:'11111111-1111-4111-8111-111111111111',email:'qa@example.test'};
 const profile={id:user.id,name:'QA Customer',email:user.email,code:'123456',cash:1000,funding:50,assets:{},country:'pk',created:new Date().toISOString(),updated:new Date().toISOString(),disabled:false,admin:false,perms:{}};
 window.__dbCalls=[];window.__rpcCalls=[];
 const rows={profiles:[profile],request_rows:[],support_threads:[],support_messages:[],user_settings:[],app_settings:[]};
 const client={auth:{getSession:async()=>({data:{session:{user,access_token:'fixture'}}}),onAuthStateChange:()=>({}),signOut:async()=>({})},channel:()=>({on(){return this;},subscribe(cb){cb('SUBSCRIBED');return this;}}),removeChannel:()=>Promise.resolve(),from(table){
  const q={op:'select',filters:[],offset:0,end:Infinity,singleRow:false,select(){return this;},eq(k,v){this.filters.push(r=>r[k]===v);return this;},in(k,v){this.filters.push(r=>v.includes(r[k]));return this;},not(){return this;},order(){return this;},range(a,b){this.offset=a;this.end=b;return this;},limit(n){this.end=n-1;return this;},maybeSingle(){this.singleRow=true;return this;},single(){this.singleRow=true;return this;},update(v){this.op='update';this.value=v;return this;},upsert(v){this.op='upsert';this.value=v;return this;},insert(v){this.op='insert';this.value=v;return this;},delete(){this.op='delete';return this;},then(yes,no){return new Promise(r=>setTimeout(()=>{window.__dbCalls.push({table,op:this.op});let result=(rows[table]||[]).filter(x=>this.filters.every(f=>f(x))).slice(this.offset,this.end+1);if(this.op==='update'){result.forEach(x=>Object.assign(x,this.value));}if(this.op==='upsert'||this.op==='insert'){result=[this.value];rows[table].push(this.value);}r({data:structuredClone(this.singleRow?result[0]||null:result),error:null});},60)).then(yes,no);}};
  return q;
 },rpc:async(name,args)=>{window.__rpcCalls.push({name,args});return {data:null,error:{code:'P0001',message:'Fixture rejected this trade'}};}};
 window.supabase={createClient:()=>client};
 window.WebSocket=class{constructor(){this.readyState=0;}close(){}};
}
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const results=[];
 try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.addInitScript(seedBrowser);
  await context.route('**/*',async route=>{
   const url=route.request().url();if(url.startsWith(base))return route.continue();
   if(url.includes('/klines')){
    const now=Math.floor(Date.now()/60000)*60000;
    return route.fulfill({contentType:'application/json',body:JSON.stringify(Array.from({length:160},(_,i)=>[now-(160-i)*60000,'60000','60100','59900','60020','3',now-(159-i)*60000-1,'180060',1]))});
   }
   if(url.includes('/ticker/24hr'))return route.fulfill({contentType:'application/json',body:JSON.stringify(['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','AVAX','LINK','TRX','DOT','LTC'].map(sym=>({symbol:sym+'USDT',lastPrice:'60020',priceChangePercent:'1.4',quoteVolume:'1000000',volume:'500',highPrice:'61000',lowPrice:'59000',openPrice:'59200'})))});
   return route.abort();
  });
  for(const name of ['dashboard','assets','markets','trade','history','demo','settings']){
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/'+name+'.html',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.BitbaseDB?.status()==='ready'&&!document.getElementById('shellLoading'));
   await page.locator('.dash-nav').waitFor();
   assert.equal(await page.locator('.user-name').first().textContent(),'QA');
   if(name==='trade'){
    await page.waitForFunction(()=>parseFloat((document.getElementById('tpPriceBig')?.textContent||'').replaceAll(',',''))>0);
    await page.locator('#amtInput').fill('200');await page.locator('#btnUp').click();
    await page.waitForFunction(()=>window.__rpcCalls.length===1);
    assert.equal(await page.locator('#balance').textContent(),'1,000.00');
    await page.waitForFunction(()=>!document.querySelector('#btnUp').disabled);
    assert.match(await page.locator('.trade-toast').textContent(),/Fixture rejected/);
   }
   const info=await page.evaluate(()=>({dom:Math.round(performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd),overflow:document.documentElement.scrollWidth>innerWidth+2,reads:window.__dbCalls.filter(x=>x.op==='select').length,writes:window.__dbCalls.filter(x=>x.op!=='select').length,icons:document.querySelectorAll('svg.lucide').length}));
   if(['dashboard','trade','settings'].includes(name))await page.screenshot({path:path.join(output,name+'-'+width+'.png'),fullPage:true});
   results.push({page:name,width,...info,errors});assert.deepEqual(errors,[],name+' browser errors');
   await page.close();
  }
  await context.close();
 }
 console.log(JSON.stringify(results,null,2));fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify(results,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
