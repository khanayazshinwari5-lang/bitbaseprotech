-- Integration assertions for a STAGING Supabase project after INSTALL.sql.
-- Entire test rolls back. No live market requests and no browser is used.
-- Fixture quotes test accounting; LIVE-CHECK.md tests the real scheduled price feed.
begin;
do $$
declare u uuid:=gen_random_uuid(); tid uuid; first_id uuid; d jsonb; n numeric; count_rows integer;
begin
 insert into auth.users(id,email,raw_user_meta_data) values(u,'settlement-test-'||u||'@example.invalid','{"name":"Settlement regression"}');
 update public.profiles set cash=1000 where id=u;
 perform set_config('request.jwt.claim.sub',u::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
 update public.trade_worker_health set last_run=now() where id;

 tid:=gen_random_uuid();first_id:=tid;
 d:=public.bb_place_contract(tid,'BTC','UP',200,300);
 d:=public.bb_place_contract(tid,'BTC','UP',200,300);
 select cash into n from public.profiles where id=u;
 assert n=800,'Duplicate placement deducted twice';
 select count(*) into count_rows from public.trade_ledger where contract_id=tid and entry_type='reserve';
 assert count_rows=1,'Duplicate reserve ledger entries';
 begin
   perform public.bb_place_contract(tid,'BTC','UP',201,300);
   raise exception 'Different payload using same ID was accepted';
 exception when raise_exception then
   if sqlerrm='Different payload using same ID was accepted' then raise; end if;
 end;
 update public.trade_contracts set starts_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute',entry_price=60000 where id=tid;
 perform public.bb_apply_contract_quote(tid,'exit',61000,(select expires_at from public.trade_contracts where id=tid));
 perform public.bb_apply_contract_quote(tid,'exit',61000,(select expires_at from public.trade_contracts where id=tid));
 select cash into n from public.profiles where id=u;
 assert n=1060,'Winning payout must return 200 plus 60 exactly once';
 assert (select net=60 and payout=260 and status='Won' and not forced from public.trade_contracts where id=tid),'Win history is wrong';
 assert not exists(select 1 from public.request_rows where id=(select position_row_id from public.trade_contracts where id=tid)),'Settled position remains open';

 tid:=gen_random_uuid();d:=public.bb_place_contract(tid,'BTC','DOWN',200,300);
 update public.trade_contracts set starts_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute',entry_price=60000 where id=tid;
 perform public.bb_apply_contract_quote(tid,'exit',61000,(select expires_at from public.trade_contracts where id=tid));
 select cash into n from public.profiles where id=u;
 assert n=1000,'Loss must return 200 minus 60';
 assert (select status='Lost' and payout=140 and net=-60 and not forced from public.trade_contracts where id=tid),'Loss history is wrong';

 -- Profit Mode: the console switch decides the verdict, and the real expiry
 -- price is still fetched, stored and used for the ledger's balance_after.
 tid:=gen_random_uuid();d:=public.bb_place_contract(tid,'BTC','DOWN',200,300);
 update public.profiles set profit_mode=true where id=u;
 update public.trade_contracts set starts_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute',entry_price=60000 where id=tid;
 perform public.bb_apply_contract_quote(tid,'exit',61000,(select expires_at from public.trade_contracts where id=tid));
 select cash into n from public.profiles where id=u;
 assert n=1060,'Profit Mode must settle a losing real contract as a win: 200 plus 60';
 assert (select status='Won' and payout=260 and net=60 and forced from public.trade_contracts where id=tid),'Profit Mode win is wrong or not marked forced';
 assert (select exit_price=61000 from public.trade_contracts where id=tid),'Profit Mode must still store the real exit price';
 assert (select count(*) from public.trade_ledger where contract_id=tid and entry_type='settlement')=1,'Profit Mode credited twice';
 update public.profiles set profit_mode=false where id=u;
 select cash into n from public.profiles where id=u;
 assert n=1060,'Turning Profit Mode off must not move a balance';

 tid:=gen_random_uuid();d:=public.bb_place_contract(tid,'BTC','DOWN',200,300);
 update public.trade_contracts set starts_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute',entry_price=60000 where id=tid;
 perform public.bb_apply_contract_quote(tid,'exit',60000,(select expires_at from public.trade_contracts where id=tid));
 select cash into n from public.profiles where id=u;
 assert n=1060,'Draw must refund the entire stake';
 assert (select status='Draw' and net=0 and not forced from public.trade_contracts where id=tid),'Draw was treated as a win/loss';

 -- Profit Mode still needs a real expiry: a contract that is not due is not settled.
 tid:=gen_random_uuid();d:=public.bb_place_contract(tid,'BTC','DOWN',200,300);
 update public.profiles set profit_mode=true where id=u;
 update public.trade_contracts set starts_at=now()-interval '1 minute',expires_at=now()+interval '4 minutes',entry_price=60000 where id=tid;
 begin
   perform public.bb_apply_contract_quote(tid,'exit',61000,(select expires_at from public.trade_contracts where id=tid));
   raise exception 'Profit Mode settled a contract that is not due';
 exception when raise_exception then
   if sqlerrm='Profit Mode settled a contract that is not due' then raise; end if;
 end;
 assert (select status='Active' from public.trade_contracts where id=tid),'Profit Mode settled a running contract';
 update public.profiles set profit_mode=false where id=u;

 tid:=gen_random_uuid();d:=public.bb_place_contract(tid,'ETH','UP',200,300);
 update public.trade_contracts set entry_price=100 where id=tid;
 d:=public.bb_close_contract(tid);d:=public.bb_close_contract(tid);
 select cash into n from public.profiles where id=u;
 assert n=760,'Early close must return 50 percent once';

 tid:=gen_random_uuid();d:=public.bb_place_contract(tid,'ETH','UP',200,300);
 update public.trade_contracts set starts_at=now()-interval '2 minutes',expires_at=now()+interval '3 minutes' where id=tid;
 perform public.bb_refund_unpriced_contract(tid);perform public.bb_refund_unpriced_contract(tid);
 select cash into n from public.profiles where id=u;
 assert n=760,'Missing entry must return the full reservation once';
 assert (select status='Cancelled' and net=0 from public.trade_contracts where id=tid),'Missing entry was not cancelled';

 begin
   perform public.bb_place_contract(gen_random_uuid(),'BTC','UP',999999,300);
   raise exception 'Overspend was accepted';
 exception when raise_exception then
   if sqlerrm='Overspend was accepted' then raise; end if;
 end;
 select cash into n from public.profiles where id=u;
 assert n=760,'Rejected order changed cash';
 assert not has_function_privilege('authenticated','public.bb_apply_contract_quote(uuid,text,numeric,timestamp with time zone)','EXECUTE'),'Client can inject an outcome';
 assert not has_function_privilege('authenticated','public.bb_contract_worker()','EXECUTE'),'Client can run the private worker';
 assert has_function_privilege('authenticated','public.bb_delete_account(uuid)','EXECUTE'),'A signed-in admin cannot reach the account removal function';
 assert not has_function_privilege('anon','public.bb_delete_account(uuid)','EXECUTE'),'An anonymous caller can reach the account removal function';
 assert not has_table_privilege('authenticated','public.trade_contracts','UPDATE'),'Client can alter canonical contracts';
 -- bb_delete_account checks is_admin() itself, so a signed-in admin is the gate.
 assert (select prosecdef from pg_proc where oid='public.bb_delete_account(uuid)'::regprocedure),'Account removal does not run with its own rights';
 raise notice 'Settlement regression checks passed: placement retries, win/loss/draw, profit mode, duplicate credits, early close, missing prices and grants.';
end $$;
rollback;
