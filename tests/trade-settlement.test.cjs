const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {Server,app}=require('./fake-supabase.cjs');
const root=path.resolve(__dirname,'..');
const cash=v=>Math.round(Number(v)*100)/100;

/* Browser-only legacy/offline arithmetic. Real contracts are tested separately and never use this path. */
function withTrades(t,seed,fn){
  const s=new Server(),user=s.seed('trader@example.test'),a=app(s,user);
  t.after(()=>a.close());
  return a.DB.ready.then(()=>{
    a.A.isRemote=()=>false;
    if(seed)a.A.adminSetCash(a.A.currentUser().uid,seed);
    a.window.BitbaseFeed={
      coins:[],instruments:[{sym:'BTC',group:'crypto'}],
      instrument:s=>({sym:s,group:'crypto'}),pairLabel:s=>s+'/USDT',
      loadMarkets:async()=>[a.window.__prices||{sym:'BTC',price:60000}],
      loadGroup:async()=>[]
    };
    vm.runInContext(fs.readFileSync(path.join(root,'assets/js/trades.js'),'utf8'),a.context,{filename:'trades.js'});
    return fn(a,a.window.BitbaseTrades);
  });
}

/* Places a contract the way the trade page does: the stake leaves the balance
   and the position is recorded open. Everything below then only ever measures
   what settlement does to that held stake. */
function place(a,T,overrides){
  const p=Object.assign({sym:'BTC',pair:'BTC/USDT',group:'crypto',dur:15,status:'Active',
    entryPrice:60000,startTime:Date.now()-60000},overrides);
  p.id=p.id||('T-'+Math.round(p.amt));
  a.A.setCash(cash(a.A.cash())-p.amt);
  a.A.writeJSON('bb_trade_positions',(a.A.readJSON('bb_trade_positions',[])||[]).concat([p]));
  return p;
}

test('a loss costs the profit percentage, not the whole stake',async t=>{
  await withTrades(t,1000,(a,T)=>{
    // 200 leaves the balance as 800 with the stake held.
    place(a,T,{id:'T-1',dir:'DOWN',amt:200,profit:60});
    assert.equal(cash(a.A.cash()),800);
    // Price above the entry, so a DOWN contract loses.
    a.window.__prices={sym:'BTC',price:61000};
    return T.settleDue('real',T.pricer()).then(settled=>{
      assert.equal(settled.length,1,'the contract was not settled');
      assert.equal(settled[0].status,'Lost');
      // The stake comes back less the 60 profit percentage: 800 + 140.
      assert.equal(cash(a.A.cash()),940,'a loss did not cost only the profit percentage');
      assert.equal(settled[0].net,-60);
      assert.equal(a.A.readJSON('bb_trade_positions',[]).length,0,'a settled contract is still open');
    });
  });
});

test('a win and a loss are mirror images of each other',async t=>{
  await withTrades(t,1000,(a,T)=>{
    a.window.__prices={sym:'BTC',price:61000};
    place(a,T,{id:'T-win',dir:'UP',amt:200,profit:60});
    place(a,T,{id:'T-lose',dir:'DOWN',amt:200,profit:60});
    assert.equal(cash(a.A.cash()),600,'the stakes were not held');
    return T.settleDue('real',T.pricer()).then(settled=>{
      assert.equal(settled.length,2);
      const win=settled.find(s=>s.id==='T-win'),lose=settled.find(s=>s.id==='T-lose');
      assert.equal(win.status,'Won');
      assert.equal(lose.status,'Lost');
      assert.equal(win.net,60);
      assert.equal(lose.net,-60);
      // +60 then -60 leaves the balance exactly where it started.
      assert.equal(cash(a.A.cash()),1000);
      // The stake is returned either way.
      assert.equal(win.payout,260);
      assert.equal(lose.payout,140);
    });
  });
});

test('a contract is never decided against a price of zero',async t=>{
  await withTrades(t,1000,(a,T)=>{
    a.A.writeJSON('bb_trade_positions',[
      {id:'T-1',sym:'BTC',pair:'BTC/USDT',group:'crypto',dir:'DOWN',amt:200,profit:60,
       entryPrice:60000,startTime:Date.now()-60000,dur:15,status:'Active'}
    ]);
    // No feed price at all. Zero is never above the entry, so judging a DOWN
    // contract against it used to mark every one of them a winner.
    a.window.BitbaseFeed=null;
    return T.settleDue('real',()=>0).then(settled=>{
      assert.equal(settled.length,0,'a contract was settled with no price');
      assert.equal(cash(a.A.cash()),1000,'the balance moved with no price');
      assert.equal(a.A.readJSON('bb_trade_positions',[]).length,1,'the contract was closed with no price');
    });
  });
});

test('a contract that is not due yet is left alone',async t=>{
  await withTrades(t,1000,(a,T)=>{
    a.window.__prices={sym:'BTC',price:61000};
    place(a,T,{id:'T-open',dir:'UP',amt:200,profit:60,startTime:Date.now(),dur:3600});
    return T.settleDue('real',T.pricer()).then(settled=>{
      assert.equal(settled.length,0);
      assert.equal(a.A.readJSON('bb_trade_positions',[]).length,1);
      assert.equal(cash(a.A.cash()),800,'the balance moved while the contract was still running');
    });
  });
});

test('a contract is settled once, however many sweeps see it',async t=>{
  await withTrades(t,1000,(a,T)=>{
    a.window.__prices={sym:'BTC',price:61000};
    place(a,T,{id:'T-1',dir:'UP',amt:200,profit:60});
    return T.settleDue('real',T.pricer())
      .then(()=>T.settleDue('real',T.pricer()))
      .then(()=>T.settleDue('real',T.pricer()))
      .then(settled=>{
        assert.equal(settled.length,0,'a later sweep settled it again');
        assert.equal(cash(a.A.cash()),1060,'the profit was paid more than once');
      });
  });
});

test('two sweeps racing over one contract pay out once',async t=>{
  await withTrades(t,1000,(a,T)=>{
    a.window.__prices={sym:'BTC',price:61000};
    place(a,T,{id:'T-1',dir:'UP',amt:200,profit:60});
    const pricer=T.pricer();
    return Promise.all([T.settleDue('real',pricer),T.settleDue('real',pricer)]).then(both=>{
      const paid=both[0].length+both[1].length;
      assert.equal(paid,1,'both sweeps paid out for one contract');
      assert.equal(cash(a.A.cash()),1060);
    });
  });
});

test('paying out is clamped to double the stake at the very least',async t=>{
  await withTrades(t,0,(a,T)=>{
    // A 24h contract can carry a 100% profit: a loss returns nothing rather
    // than a negative payout.
    assert.equal(cash(T.payout({amt:200,profit:200},false)),0);
    assert.equal(cash(T.payout({amt:200,profit:200},true)),400);
    // A profit larger than the stake cannot overpay.
    assert.equal(cash(T.payout({amt:200,profit:9999},true)),400);
  });
});

/* The user's scenario: a contract is running, the user leaves the trade page,
   and the next page they open is the one that closes it. */
test('offline mode settles a due contract when a page is opened',async t=>{
  const s=new Server(),user=s.seed('leaver@example.test'),a=app(s,user);
  t.after(()=>a.close());
  await a.DB.ready;
  a.A.isRemote=()=>false;
  const uid=a.A.currentUser().uid;
  a.A.adminSetCash(uid,1000);
  a.A.writeJSON('bb_trade_positions',[
    {id:'T-1',sym:'BTC',pair:'BTC/USDT',group:'crypto',uid,dir:'UP',amt:200,profit:60,
     entryPrice:60000,startTime:Date.now()-60000,dur:15,status:'Active',mode:'real'}
  ]);
  // The stake is held: out of the balance, and still listed as running.
  a.A.setCash(800);

  // A second page in the same session loads trades.js, as every page now does.
  a.window.BitbaseFeed={
    coins:[],instruments:[{sym:'BTC',group:'crypto'}],
    instrument:s=>({sym:s,group:'crypto'}),pairLabel:s=>s+'/USDT',
    loadMarkets:async()=>[{sym:'BTC',price:61000}],loadGroup:async()=>[]
  };
  const settledEvents=[];
  a.window.addEventListener('bitbase:settled',e=>settledEvents.push(e.detail));
  vm.runInContext(fs.readFileSync(path.join(root,'assets/js/trades.js'),'utf8'),a.context,{filename:'trades.js'});
  await new Promise(r=>setTimeout(r,120));

  assert.equal(a.A.readJSON('bb_trade_positions',[]).length,0,'the contract is still open');
  assert.equal(settledEvents.length,1,'the page was not told about the settlement');
  assert.equal(settledEvents[0].status,'Won');
  // 800 held, then the stake back plus the 60 profit.
  assert.equal(cash(a.A.cash()),1060);
  const hist=a.A.readJSON('bb_trades_history',[]);
  assert.equal(hist.length,1,'the settlement was not written to history');
  assert.equal(hist[0].id,'T-1');
});