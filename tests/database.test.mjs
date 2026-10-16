import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {hash} from '../lib/core.mjs';
let db;const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';let strategy,version,approval;
const plan={title:'BTC fixed',symbol:'BTCUSDT',direction:'LONG',capital:100,margin:10,leverage:3,dailyLoss:5,maxTrades:3,validMinutes:60,entryPrice:60000,stopPrice:59000,takeProfitPrice:61000,executable:true,instructions:'Fixed prices'};
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
before(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;insert into auth.users values('${owner}'),('${other}');`);await db.exec(await readFile(new URL('../supabase/migrations/202610160001_trading_workspace.sql',import.meta.url),'utf8'));});
after(async()=>{await db?.close()});
test('migration, immutable versions, approvals, paper trades and per-version aggregate',async()=>{
 strategy=(await one('insert into strategies(user_id,title) values($1,$2) returning id',[owner,'BTC strategy'])).id;
 version=(await one('select save_strategy_chat($1,$2,$3,$4,$5,$6,$7,$8,$9) as id',[owner,strategy,'demo','hello','proposal',plan,hash(plan),'test-model',{}])).id;
 assert.equal((await one('select count(*) as n from messages')).n,2);
 await assert.rejects(()=>db.query('update strategy_versions set plan=$1 where id=$2',[{...plan,leverage:100},version]),/Immutable/);
 await assert.rejects(()=>db.query('select decide_strategy($1,$2,$3,$4)',[owner,version,'bad','approve']),/Plan mismatch/);
 approval=(await one('select decide_strategy($1,$2,$3,$4) as id',[owner,version,hash(plan),'approve'])).id;
 await db.query('select control_session($1,$2,$3)',[owner,approval,'start']);
 for(let i=0;i<3;i++)await db.query('select control_session($1,$2,$3)',[owner,approval,'paperStep']);
 const t=await one('select * from trades');assert.equal(t.strategy_version_id,version);assert.equal(t.mode,'demo');assert.ok(Number(t.net_pnl)>0);assert.equal(Number(t.fees),0.030045);
 const perf=await one('select * from strategy_performance');assert.equal(perf.trades,1);assert.equal(Number(perf.win_rate),100);assert.equal(Number(perf.net_pnl),Number(t.net_pnl));
 await assert.rejects(()=>db.query('insert into trades(user_id,session_id,strategy_version_id,mode,symbol,side,quantity,entry_price,exit_price,opened_at,closed_at,gross_pnl,fees,funding,source,external_id) select user_id,session_id,strategy_version_id,mode,symbol,side,quantity,entry_price,exit_price,opened_at,closed_at,gross_pnl,fees,funding,source,external_id from trades'),/duplicate key/);
 await assert.rejects(()=>db.query('update trades set gross_pnl=999'),/Immutable/);
 await db.query('select save_journal($1,$2,$3,$4)',[owner,t.id,'first',['review']]);await db.query('select save_journal($1,$2,$3,$4)',[owner,t.id,'edited',['review']]);
 assert.equal((await one('select notes from journal_entries')).notes,'edited');
 await assert.rejects(()=>db.query('select save_journal($1,$2,$3,$4)',[other,t.id,'cross user',[]]),/Trade not found/);
});
test('RLS filters another owner including security-invoker performance view; no client writes or RPC',async()=>{
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${other}',false);`);
 try{assert.equal((await one('select count(*) as n from strategy_versions')).n,0);assert.equal((await one('select count(*) as n from strategy_performance')).n,0);assert.equal((await one('select count(*) as n from trades')).n,0);
 await assert.rejects(()=>db.query('insert into strategies(user_id,title) values($1,$2)',[other,'forged']),/permission denied/);
 await assert.rejects(()=>db.query('select decide_strategy($1,$2,$3,$4)',[owner,version,hash(plan),'approve']),/permission denied/);
 }finally{await db.exec('reset role')}
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${owner}',false);`);
 try{assert.equal((await one('select count(*) as n from strategy_performance')).n,1)}finally{await db.exec('reset role')}
});
test('cross-owner foreign keys reject forged strategy references',async()=>{
 await assert.rejects(()=>db.query("insert into messages(user_id,strategy_id,mode,role,content) values($1,$2,'demo','user','forged')",[other,strategy]),/foreign key/);
});
test('approval expiry blocks new entries, but stop closes held demo position',async()=>{
 await db.query('select control_session($1,$2,$3)',[owner,approval,'paperStep']);
 await db.query("update approvals set expires_at=now()-interval '1 minute' where id=$1",[approval]);
 await assert.rejects(()=>db.query('select control_session($1,$2,$3)',[owner,approval,'paperStep']),/Approval expired/);
 await db.query('select control_session($1,$2,$3)',[owner,approval,'stop']);
 assert.equal((await one('select count(*) as n from trades')).n,2);assert.equal((await one('select paper_position from sessions')).paper_position,null);
});
test('new versions do not rewrite old performance; live stays blocked; quota is durable',async()=>{
 const v2=(await one('select save_strategy_chat($1,$2,$3,$4,$5,$6,$7,$8,$9) as id',[owner,strategy,'live','change','new',{...plan,leverage:5},hash({...plan,leverage:5}),'test-model',{}])).id;
 assert.equal((await one('select version from strategy_versions where id=$1',[v2])).version,2);
 await assert.rejects(()=>db.query('select decide_strategy($1,$2,$3,$4)',[owner,v2,hash({...plan,leverage:5}),'approve']),/Live execution locked/);
 const ps=(await db.query('select version,trades from strategy_performance order by version')).rows;assert.equal(ps[0].trades,2);assert.equal(ps[1].trades,0);
 await db.query('select reserve_ai_call($1,1)',[owner]);await assert.rejects(()=>db.query('select reserve_ai_call($1,1)',[owner]),/AI daily limit/);
});
test('runner snapshots are atomic, rate limited, and rejected after revocation',async()=>{
 const r=await one("insert into runner_connections(user_id,label,token_hash,expires_at) values($1,'test',$2,now()+interval '1 hour') returning id",[owner,'b'.repeat(64)]);
 const first='44444444-4444-4444-8444-444444444444';
 await db.query('select save_account_snapshot($1,$2,$3,$4,$5,$6,$7)',[r.id,owner,first,'testnet',100,0,[]]);
 await assert.rejects(()=>db.query('select save_account_snapshot($1,$2,$3,$4,$5,$6,$7)',[r.id,owner,'55555555-5555-4555-8555-555555555555','testnet',100,0,[]]),/Runner rate limit/);
 assert.equal((await one('select count(*) as n from account_snapshots')).n,1);
 await db.query('update runner_connections set revoked_at=now() where id=$1',[r.id]);
 await assert.rejects(()=>db.query('select save_account_snapshot($1,$2,$3,$4,$5,$6,$7)',[r.id,owner,first,'testnet',100,0,[]]),/Runner expired/);
});
