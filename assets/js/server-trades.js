/* Real contracts are accepted and settled by PostgreSQL. The browser only submits intent. */
(function (global) {
  'use strict';
  var DB=global.BitbaseDB, A=global.BitbaseAuth, busy=false;
  function key() { return 'bb_pending_contract:'+DB.uid(); }
  function read() { try { return JSON.parse(global.sessionStorage.getItem(key()) || 'null'); } catch (_) { return null; } }
  function remember(v) { try { if(v) global.sessionStorage.setItem(key(),JSON.stringify(v));else global.sessionStorage.removeItem(key()); } catch (_) {} }
  function same(a,b) { return ['p_symbol','p_direction','p_amount','p_duration'].every(function (k) { return a[k]===b[k]; }); }
  function message(e) {
    if (/bb_place_contract|bb_close_contract|schema cache|function.*not.*exist/i.test(e.message || ''))
      return new Error('Automatic settlement is not installed yet. Run supabase/repair-performance-settlement.sql in Supabase, then reload.');
    return e;
  }
  async function place(details) {
    if (busy) throw new Error('Please wait for the current trade request.');
    var args={p_symbol:details.sym,p_direction:details.dir,p_amount:details.amt,p_duration:details.dur};
    var pending=read();
    if (pending && !same(pending,args)) throw new Error('A previous order is unconfirmed. Retry its original amount, pair, direction and duration first.');
    args.p_id=pending ? pending.p_id : global.crypto.randomUUID();
    remember(args);busy=true;
    try { var done=await DB.tradeRpc('bb_place_contract',args);remember(null);return done; }
    catch(e) {
      // Definite database rejection: no transaction committed. Network failures retain the ID.
      if (e.code && ['P0001','42501','23514','22003','PGRST202'].indexOf(e.code)!==-1) remember(null);
      throw message(e);
    } finally { busy=false; }
  }
  async function close(id) { return DB.tradeRpc('bb_close_contract',{p_id:id}).catch(function(e){throw message(e);}); }
  global.BitbaseServerTrades={place:place,close:close,enabled:function(){return !!(A && A.isRemote());}};
})(window);
