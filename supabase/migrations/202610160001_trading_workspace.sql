begin;

create table public.strategies (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 title text not null check(length(title) between 1 and 120), created_at timestamptz not null default now(), unique(id,user_id)
);
create table public.strategy_versions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, strategy_id uuid not null,
 version integer not null check(version>0), mode text not null check(mode in ('demo','testnet','live')),
 plan jsonb not null, plan_hash text not null check(length(plan_hash)=64), model text not null,
 created_at timestamptz not null default now(), unique(strategy_id,version), unique(id,user_id), unique(id,user_id,mode),
 foreign key(strategy_id,user_id) references public.strategies(id,user_id)
);
create table public.messages (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, strategy_id uuid not null,
 mode text not null check(mode in ('demo','testnet','live')), role text not null check(role in ('user','assistant')),
 content text not null check(length(content)<=16000), strategy_version_id uuid,
 created_at timestamptz not null default now(),
 foreign key(strategy_id,user_id) references public.strategies(id,user_id),
 foreign key(strategy_version_id,user_id,mode) references public.strategy_versions(id,user_id,mode)
);
create table public.approvals (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, strategy_version_id uuid not null,
 mode text not null check(mode in ('demo','testnet','live')), plan_hash text not null,
 decision text not null check(decision in ('approved','rejected')), created_at timestamptz not null default now(),
 expires_at timestamptz not null, revoked_at timestamptz, unique(id,user_id),unique(id,user_id,strategy_version_id,mode),
 foreign key(strategy_version_id,user_id,mode) references public.strategy_versions(id,user_id,mode)
);
create table public.sessions (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,approval_id uuid not null unique,
 strategy_version_id uuid not null,mode text not null check(mode in ('demo','testnet','live')),
 state text not null default 'stopped' check(state in ('running','stopped','error')),
 paper_position jsonb, created_at timestamptz not null default now(),unique(id,user_id,strategy_version_id,mode),
 foreign key(approval_id,user_id,strategy_version_id,mode) references public.approvals(id,user_id,strategy_version_id,mode)
);
create table public.trades (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,session_id uuid not null,
 strategy_version_id uuid not null,mode text not null check(mode in ('demo','testnet','live')),
 symbol text not null,side text not null check(side in ('LONG','SHORT')),quantity numeric not null check(quantity>0),
 entry_price numeric not null check(entry_price>0),exit_price numeric not null check(exit_price>0),
 opened_at timestamptz not null,closed_at timestamptz not null,gross_pnl numeric not null,
 fees numeric not null default 0 check(fees>=0),funding numeric not null default 0,
 net_pnl numeric generated always as(gross_pnl-fees+funding) stored,
 source text not null check(source in ('simulation','binance')),external_id text not null,
 created_at timestamptz not null default now(),unique(user_id,mode,external_id),unique(id,user_id),
 foreign key(session_id,user_id,strategy_version_id,mode) references public.sessions(id,user_id,strategy_version_id,mode),
 check(closed_at>=opened_at),check((mode='demo' and source='simulation') or (mode<>'demo' and source='binance'))
);
create table public.journal_entries (
 id uuid primary key default gen_random_uuid(),user_id uuid not null,trade_id uuid not null unique,
 notes text not null default '' check(length(notes)<=6000), tags text[] not null default '{}',
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(trade_id,user_id) references public.trades(id,user_id)
);
create table public.runner_connections (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),
 label text not null,token_hash text not null unique,expires_at timestamptz not null,revoked_at timestamptz,last_seen timestamptz,
 created_at timestamptz not null default now(),unique(id,user_id)
);
create unique index one_active_runner on public.runner_connections(user_id) where revoked_at is null;
create table public.account_snapshots (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),runner_id uuid not null,
 mode text not null check(mode in ('testnet','live')),balance numeric not null,unrealized_pnl numeric not null,
 positions jsonb not null,created_at timestamptz not null default now(),
 foreign key(runner_id,user_id) references public.runner_connections(id,user_id)
);
create table public.ai_calls (
 id bigint generated always as identity primary key,user_id uuid not null references auth.users(id),created_at timestamptz not null default now()
);
create table public.ai_usage (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),model text not null,usage jsonb not null,
 created_at timestamptz not null default now()
);
create index trades_owner_closed on public.trades(user_id,mode,closed_at desc);
create index versions_owner on public.strategy_versions(user_id,strategy_id,version desc);
create index messages_owner on public.messages(user_id,strategy_id,mode,created_at desc);
create index snapshots_owner on public.account_snapshots(user_id,created_at desc);
create index calls_owner on public.ai_calls(user_id,created_at desc);

-- Clients can only SELECT their rows. All mutations use authenticated server routes.
-- Composite foreign keys prevent records from referencing another owner's strategy/trade.
do $$declare t text;begin
 foreach t in array array['strategies','strategy_versions','messages','approvals','sessions','trades','journal_entries','runner_connections','account_snapshots','ai_calls','ai_usage'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  if t<>'runner_connections' then
   execute format('grant select on public.%I to authenticated',t);
   execute format('create policy own_read on public.%I for select to authenticated using ((select auth.uid()) = user_id)',t);
  end if;
  execute format('grant all on public.%I to service_role',t);
 end loop;
end$$;
grant usage,select on sequence public.ai_calls_id_seq to service_role;

create function public.immutable_record() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Immutable audit record';end$$;
create trigger immutable_version before update or delete on public.strategy_versions for each row execute function public.immutable_record();
create trigger immutable_trade before update or delete on public.trades for each row execute function public.immutable_record();

create function public.reserve_ai_call(p_user uuid,p_limit integer) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||':ai',0));
 if (select count(*) from public.ai_calls where user_id=p_user and created_at>now()-interval '1 day')>=least(greatest(p_limit,1),10000) then raise exception 'AI daily limit reached';end if;
 insert into public.ai_calls(user_id) values(p_user);return true;
end$$;

create function public.save_strategy_chat(p_user uuid,p_strategy uuid,p_mode text,p_user_message text,p_reply text,p_plan jsonb,p_hash text,p_model text,p_usage jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid;v_num integer;
begin
 perform 1 from public.strategies where id=p_strategy and user_id=p_user for update;
 if not found then raise exception 'Strategy not found';end if;
 if p_plan is not null then
  select coalesce(max(version),0)+1 into v_num from public.strategy_versions where strategy_id=p_strategy;
  insert into public.strategy_versions(user_id,strategy_id,version,mode,plan,plan_hash,model) values(p_user,p_strategy,v_num,p_mode,p_plan,p_hash,p_model) returning id into v_id;
 end if;
 insert into public.messages(user_id,strategy_id,mode,role,content) values(p_user,p_strategy,p_mode,'user',p_user_message);
 insert into public.messages(user_id,strategy_id,mode,role,content,strategy_version_id) values(p_user,p_strategy,p_mode,'assistant',p_reply,v_id);
 insert into public.ai_usage(user_id,model,usage) values(p_user,p_model,p_usage);
 return v_id;
end$$;

create function public.decide_strategy(p_user uuid,p_version uuid,p_hash text,p_decision text) returns uuid language plpgsql security invoker set search_path='' as $$
declare v public.strategy_versions; a_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||':approval',0));
 select * into v from public.strategy_versions where id=p_version and user_id=p_user;
 if not found or v.plan_hash<>p_hash then raise exception 'Plan mismatch';end if;
 if v.mode='live' and p_decision='approve' then raise exception 'Live execution locked';end if;
 if p_decision='revoke' then
  update public.approvals set revoked_at=now() where user_id=p_user and strategy_version_id=v.id and revoked_at is null;
  -- paper positions must be closed using the stop command before revoking.
  if exists(select 1 from public.sessions where user_id=p_user and mode=v.mode and (paper_position is not null or state='running')) then raise exception 'Stop active session first';end if;
  return v.id;
 end if;
 if p_decision not in ('approve','reject') then raise exception 'Invalid decision';end if;
 if p_decision='approve' then
  if exists(select 1 from public.sessions where user_id=p_user and mode=v.mode and (state='running' or paper_position is not null)) then raise exception 'Stop active session first';end if;
  update public.approvals set revoked_at=now() where user_id=p_user and mode=v.mode and revoked_at is null;
 end if;
 insert into public.approvals(user_id,strategy_version_id,mode,plan_hash,decision,expires_at)
 values(p_user,v.id,v.mode,v.plan_hash,case when p_decision='approve' then 'approved' else 'rejected' end,now()+make_interval(mins=>(v.plan->>'validMinutes')::integer)) returning id into a_id;
 return a_id;
end$$;

create function public.control_session(p_user uuid,p_approval uuid,p_command text) returns uuid language plpgsql security invoker set search_path='' as $$
declare a public.approvals;v public.strategy_versions;s public.sessions;q numeric;en numeric;ex numeric;sg numeric;daily numeric;n bigint;pos jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||':approval',0));
 select * into a from public.approvals where id=p_approval and user_id=p_user;
 if not found then raise exception 'Approval not found';end if;
 select * into v from public.strategy_versions where id=a.strategy_version_id and user_id=p_user;
 if a.mode='live' then raise exception 'Live execution locked';end if;
 select * into s from public.sessions where approval_id=a.id and user_id=p_user for update;
 if p_command='stop' then
  if s.id is null then return null;end if;
  -- Stop is always allowed, including an expired/revoked approval; close simulation position.
  if s.paper_position is not null then
   pos=s.paper_position;en=(pos->>'entry')::numeric;q=(pos->>'quantity')::numeric;ex=coalesce((pos->>'mark')::numeric,en);sg=case when v.plan->>'direction'='LONG' then 1 else -1 end;
   insert into public.trades(user_id,session_id,strategy_version_id,mode,symbol,side,quantity,entry_price,exit_price,opened_at,closed_at,gross_pnl,fees,source,external_id)
   values(p_user,s.id,v.id,'demo',v.plan->>'symbol',v.plan->>'direction',q,en,ex,(pos->>'openedAt')::timestamptz,clock_timestamp(),(ex-en)*q*sg,(en+ex)*q*0.0005,'simulation',pos->>'tradeId');
  end if;
  update public.sessions set state='stopped',paper_position=null where id=s.id;return s.id;
 end if;
 if a.decision<>'approved' or a.revoked_at is not null or a.expires_at<=now() or a.plan_hash<>v.plan_hash then raise exception 'Approval expired';end if;
 if p_command='start' then
  -- Testnet execution is not enabled by a browser command in this release.
  if a.mode<>'demo' then raise exception 'Testnet execution pending validation';end if;
  if exists(select 1 from public.sessions where user_id=p_user and mode=a.mode and state='running' and approval_id<>a.id) then raise exception 'Stop active session first';end if;
  insert into public.sessions(user_id,approval_id,strategy_version_id,mode,state) values(p_user,a.id,v.id,a.mode,'running') on conflict(approval_id) do update set state='running' returning id into s.id;return s.id;
 end if;
 if p_command<>'paperStep' or a.mode<>'demo' or s.state<>'running' or s.id is null then raise exception 'Simulation not running';end if;
 en=coalesce((v.plan->>'entryPrice')::numeric,case when v.plan->>'symbol'='ETHUSDT' then 3000 when v.plan->>'symbol'='SOLUSDT' then 150 else 60000 end);
 sg=case when v.plan->>'direction'='LONG' then 1 else -1 end;
 if s.paper_position is null then
  select coalesce(sum(net_pnl),0),count(*) into daily,n from public.trades where user_id=p_user and mode='demo' and closed_at>=date_trunc('day',now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  if daily<=-(v.plan->>'dailyLoss')::numeric or n>=(v.plan->>'maxTrades')::integer then raise exception 'Daily session limit reached';end if;
  q=(v.plan->>'margin')::numeric*(v.plan->>'leverage')::numeric/en;
  update public.sessions set paper_position=jsonb_build_object('entry',en,'mark',en,'quantity',q,'openedAt',clock_timestamp(),'tradeId',gen_random_uuid(),'step',1) where id=s.id;
 elsif (s.paper_position->>'step')::integer=1 then
  update public.sessions set paper_position=paper_position||jsonb_build_object('mark',en*(1+0.003*sg),'step',2) where id=s.id;
 else
  pos=s.paper_position;q=(pos->>'quantity')::numeric;en=(pos->>'entry')::numeric;ex=(pos->>'mark')::numeric;
  insert into public.trades(user_id,session_id,strategy_version_id,mode,symbol,side,quantity,entry_price,exit_price,opened_at,closed_at,gross_pnl,fees,source,external_id)
  values(p_user,s.id,v.id,'demo',v.plan->>'symbol',v.plan->>'direction',q,en,ex,(pos->>'openedAt')::timestamptz,clock_timestamp(),(ex-en)*q*sg,(en+ex)*q*0.0005,'simulation',pos->>'tradeId');
  update public.sessions set paper_position=null where id=s.id;
 end if;
 return s.id;
end$$;

create function public.save_journal(p_user uuid,p_trade uuid,p_notes text,p_tags text[]) returns uuid language plpgsql security invoker set search_path='' as $$
declare j_id uuid;begin
 if not exists(select 1 from public.trades where id=p_trade and user_id=p_user) then raise exception 'Trade not found';end if;
 insert into public.journal_entries(user_id,trade_id,notes,tags) values(p_user,p_trade,p_notes,p_tags)
 on conflict(trade_id) do update set notes=excluded.notes,tags=excluded.tags,updated_at=now() returning id into j_id;return j_id;
end$$;

create view public.strategy_performance with (security_invoker=true) as
select v.user_id,v.id as strategy_version_id,v.strategy_id,v.version,v.mode,s.title,
 count(t.id) as trades,count(t.id) filter(where t.net_pnl>0) as wins,
 coalesce(sum(t.net_pnl),0) as net_pnl,coalesce(sum(t.fees),0) as fees,coalesce(sum(t.funding),0) as funding,
 case when count(t.id)>0 then 100.0*count(t.id) filter(where t.net_pnl>0)/count(t.id) else null end as win_rate,
 sum(t.net_pnl) filter(where t.net_pnl>0)/nullif(-sum(t.net_pnl) filter(where t.net_pnl<0),0) as profit_factor
from public.strategy_versions v join public.strategies s on s.id=v.strategy_id and s.user_id=v.user_id
left join public.trades t on t.strategy_version_id=v.id and t.user_id=v.user_id and t.mode=v.mode
 group by v.user_id,v.id,v.strategy_id,v.version,v.mode,s.title;
revoke all on public.strategy_performance from anon;
grant select on public.strategy_performance to authenticated,service_role;
create function public.save_account_snapshot(p_runner uuid,p_user uuid,p_id uuid,p_mode text,p_balance numeric,p_unreal numeric,p_positions jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.runner_connections;
begin
 select * into r from public.runner_connections where id=p_runner and user_id=p_user for update;
 if not found or r.revoked_at is not null or r.expires_at<=now() then raise exception 'Runner expired';end if;
 if r.last_seen>now()-interval '10 seconds' then raise exception 'Runner rate limit';end if;
 insert into public.account_snapshots(id,user_id,runner_id,mode,balance,unrealized_pnl,positions) values(p_id,p_user,p_runner,p_mode,p_balance,p_unreal,p_positions);
 update public.runner_connections set last_seen=now() where id=p_runner;
 return p_id;
end$$;
-- No RPC can be executed directly by a browser JWT or anon key.
do $$declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('immutable_record','reserve_ai_call','save_strategy_chat','decide_strategy','control_session','save_journal','save_account_snapshot') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end$$;
commit;
