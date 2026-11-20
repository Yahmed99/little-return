begin;

create schema if not exists private;
create table private.goal_api_quota (
  day date not null,
  scope text not null,
  attempts integer not null,
  last_attempt timestamptz not null,
  primary key (day, scope)
);
alter table private.goal_api_quota enable row level security;
revoke all on private.goal_api_quota from public, anon, authenticated;

create function public.consume_goal_api_quota(caller_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_at timestamptz;
  request_day date;
  user_scope text := caller_id::text;
  global_attempts integer;
  user_attempts integer;
  previous_attempt timestamptz;
  reset_in integer;
begin
  if caller_id is null then
    raise exception 'A verified user is required';
  end if;

  -- Serialize reservations so concurrent requests cannot exceed either cap.
  perform pg_catalog.pg_advisory_xact_lock(192804, 6221);
  requested_at := pg_catalog.clock_timestamp();
  request_day := (requested_at at time zone 'UTC')::date;
  reset_in := greatest(1, ceil(extract(epoch from
    (((request_day + 1)::timestamp at time zone 'UTC') - requested_at)))::integer);

  select attempts into global_attempts from private.goal_api_quota
    where day = request_day and scope = 'global';
  select attempts, last_attempt into user_attempts, previous_attempt from private.goal_api_quota
    where day = request_day and scope = user_scope;

  if coalesce(global_attempts, 0) >= 1000 or coalesce(user_attempts, 0) >= 10 then
    return reset_in;
  end if;
  if previous_attempt is null then
    select last_attempt into previous_attempt from private.goal_api_quota
      where day = request_day - 1 and scope = user_scope;
  end if;
  if previous_attempt > requested_at - interval '10 seconds' then
    return greatest(1, ceil(extract(epoch from
      (previous_attempt + interval '10 seconds' - requested_at)))::integer);
  end if;

  insert into private.goal_api_quota as quota (day, scope, attempts, last_attempt)
    values (request_day, 'global', 1, requested_at), (request_day, user_scope, 1, requested_at)
    on conflict (day, scope) do update
    set attempts = quota.attempts + 1, last_attempt = excluded.last_attempt;
  return 0;
end;
$$;

revoke all on function public.consume_goal_api_quota(uuid) from public, anon, authenticated;
grant execute on function public.consume_goal_api_quota(uuid) to service_role;

commit;
