begin;
-- Detach data ownership from Supabase Auth. No signup, auth.users insert, or account password required.
create table public.workspace_owners(id uuid primary key default gen_random_uuid());
create table public.workspace_config(singleton boolean primary key default true check(singleton),owner_id uuid not null references public.workspace_owners(id));
do $$declare t text;cnt integer;owner uuid;begin
 foreach t in array array['strategies','runner_connections','account_snapshots','ai_calls','ai_usage'] loop
  execute format('insert into public.workspace_owners(id) select distinct user_id from public.%I on conflict do nothing',t);
  execute format('alter table public.%I drop constraint %I',t,t||'_user_id_fkey');
  execute format('alter table public.%I add constraint %I foreign key(user_id) references public.workspace_owners(id)',t,t||'_user_id_fkey');
 end loop;
 select count(*) into cnt from public.workspace_owners;
 if cnt=0 then insert into public.workspace_owners default values returning id into owner;
 elsif cnt=1 then select id into owner from public.workspace_owners;
 else raise exception 'Multiple data owners: select an owner before migrating the personal workspace';end if;
 insert into public.workspace_config(owner_id) values(owner);
 -- Old Supabase JWTs must not retain direct DB access after this change.
 foreach t in array array['strategies','strategy_versions','messages','approvals','sessions','trades','journal_entries','runner_connections','account_snapshots','ai_calls','ai_usage'] loop
  execute format('drop policy if exists own_read on public.%I',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
 end loop;
end$$;
revoke all on public.strategy_performance from anon,authenticated;
alter table public.workspace_owners enable row level security;
alter table public.workspace_config enable row level security;
revoke all on public.workspace_owners,public.workspace_config from public,anon,authenticated;
grant all on public.workspace_owners,public.workspace_config to service_role;
create table public.password_attempts(id bigint generated always as identity primary key,bucket text not null check(length(bucket)=64),created_at timestamptz not null default now());
create index password_attempts_bucket_time on public.password_attempts(bucket,created_at desc);
alter table public.password_attempts enable row level security;
revoke all on public.password_attempts from public,anon,authenticated;
grant all on public.password_attempts to service_role;
grant usage,select on sequence public.password_attempts_id_seq to service_role;
create function public.reserve_password_attempt(p_bucket text) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('password-quota',0));
 delete from public.password_attempts where created_at<now()-interval '1 day';
 if (select count(*) from public.password_attempts where bucket=p_bucket and created_at>now()-interval '15 minutes')>=10
 or (select count(*) from public.password_attempts where created_at>now()-interval '15 minutes')>=100 then raise exception 'Password attempt limit';end if;
 insert into public.password_attempts(bucket) values(p_bucket);return true;
end$$;
revoke all on function public.reserve_password_attempt(text) from public,anon,authenticated;
grant execute on function public.reserve_password_attempt(text) to service_role;
commit;
