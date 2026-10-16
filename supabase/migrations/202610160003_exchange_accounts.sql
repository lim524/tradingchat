begin;
create table public.exchange_accounts(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.workspace_owners(id),
 exchange text not null check(exchange in ('binance','bitget')),
 account_type text not null check(account_type in ('futures','classic','uta')),
 mode text not null check(mode in ('testnet','live')),
 label text not null check(length(label) between 1 and 60),created_at timestamptz not null default now(),
 check((exchange='binance' and account_type='futures') or (exchange='bitget' and account_type in ('classic','uta'))),
 unique(user_id,exchange,mode,label),unique(id,user_id),unique(id,user_id,mode)
);
alter table public.exchange_accounts enable row level security;
revoke all on public.exchange_accounts from public,anon,authenticated;
grant all on public.exchange_accounts to service_role;
-- Preserve all earlier Binance snapshots, separating production and testnet.
insert into public.exchange_accounts(user_id,exchange,account_type,mode,label)
 select o.id,'binance','futures',m.mode,'바이낸스 기본 계좌' from public.workspace_owners o cross join(values('live'),('testnet')) m(mode);
alter table public.runner_connections add column account_id uuid;
update public.runner_connections r set account_id=a.id from public.exchange_accounts a
 where a.user_id=r.user_id and a.exchange='binance' and a.mode=coalesce((select s.mode from public.account_snapshots s where s.runner_id=r.id order by s.created_at desc limit 1),'live');
alter table public.runner_connections alter column account_id set not null;
alter table public.runner_connections add foreign key(account_id,user_id) references public.exchange_accounts(id,user_id);
drop index public.one_active_runner;
create unique index one_active_runner_per_account on public.runner_connections(account_id) where revoked_at is null;
alter table public.account_snapshots add column account_id uuid;
update public.account_snapshots s set account_id=a.id from public.exchange_accounts a where a.user_id=s.user_id and a.mode=s.mode and a.exchange='binance';
alter table public.account_snapshots alter column account_id set not null;
alter table public.account_snapshots add foreign key(account_id,user_id,mode) references public.exchange_accounts(id,user_id,mode);
create index snapshots_account_time on public.account_snapshots(user_id,account_id,created_at desc);

create function public.pair_account_runner(p_user uuid,p_account uuid,p_hash text) returns public.runner_connections language plpgsql security invoker set search_path='' as $$
declare r public.runner_connections;
begin
 perform 1 from public.exchange_accounts where id=p_account and user_id=p_user for update;
 if not found then raise exception 'Account not found';end if;
 update public.runner_connections set revoked_at=now() where account_id=p_account and user_id=p_user and revoked_at is null;
 insert into public.runner_connections(user_id,account_id,label,token_hash,expires_at) values(p_user,p_account,'내 PC',p_hash,now()+interval '24 hours') returning * into r;
 return r;
end$$;
-- Keep the RPC signature stable for previously deployed Binance readers.
-- Derive account identity and environment from the token, never from a claimed user/account ID.
create or replace function public.save_account_snapshot(p_runner uuid,p_user uuid,p_id uuid,p_mode text,p_balance numeric,p_unreal numeric,p_positions jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.runner_connections;a public.exchange_accounts;
begin
 select * into r from public.runner_connections where id=p_runner and user_id=p_user for update;
 if not found or r.revoked_at is not null or r.expires_at<=now() then raise exception 'Runner expired';end if;
 select * into a from public.exchange_accounts where id=r.account_id and user_id=p_user;
 if not found or a.mode<>p_mode then raise exception 'Account mismatch';end if;
 if r.last_seen>now()-interval '10 seconds' then raise exception 'Runner rate limit';end if;
 insert into public.account_snapshots(id,user_id,runner_id,account_id,mode,balance,unrealized_pnl,positions) values(p_id,p_user,p_runner,a.id,a.mode,p_balance,p_unreal,p_positions);
 update public.runner_connections set last_seen=now() where id=p_runner;
 return p_id;
end$$;
revoke all on function public.pair_account_runner(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.pair_account_runner(uuid,uuid,text) to service_role;
commit;
