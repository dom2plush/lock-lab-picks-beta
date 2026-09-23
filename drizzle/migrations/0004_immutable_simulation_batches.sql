-- Every 50-run batch becomes a permanent, immutable record; one is current per game.
alter table public.game_simulations add column if not exists is_current boolean not null default true;
alter table public.game_simulations add column if not exists analysis_snapshot jsonb;
alter table public.game_simulations add column if not exists input_snapshot jsonb;
alter table public.game_simulations drop constraint if exists game_simulations_game_id_key;
drop index if exists public.game_simulations_game_id_key;
create unique index if not exists game_simulations_one_current
  on public.game_simulations (game_id) where is_current;

create or replace function public.game_simulations_freeze()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.analysis_snapshot is not null and (
       new.analysis_snapshot is distinct from old.analysis_snapshot
    or new.simulations is distinct from old.simulations
    or new.aggregate is distinct from old.aggregate
    or new.input_snapshot is distinct from old.input_snapshot
    or new.input_fingerprint is distinct from old.input_fingerprint
    or new.engine_version is distinct from old.engine_version
    or new.runs is distinct from old.runs
    or new.game_id is distinct from old.game_id
    or new.generated_at is distinct from old.generated_at) then
    raise exception 'A stored simulation batch is immutable';
  end if;
  return new;
end $$;
create trigger game_simulations_freeze before update on public.game_simulations
  for each row execute function public.game_simulations_freeze();

-- The displayed card points at the batch it came from.
alter table public.game_analyses add column if not exists simulation_id uuid
  references public.game_simulations(id) on delete set null;

-- Tails remember the batch, model edge and simulated hit rate they were taken from.
alter table public.tails add column if not exists simulation_id uuid
  references public.game_simulations(id) on delete set null;
alter table public.tails add column if not exists model_edge numeric;
alter table public.tails add column if not exists sim_hit_rate numeric;
alter table public.tails add column if not exists sim_hits integer;
alter table public.tails add column if not exists sim_runs integer;

create or replace function public.tails_freeze_snapshot()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.user_id is distinct from old.user_id or new.game_id is distinct from old.game_id
     or new.analysis_id is distinct from old.analysis_id or new.pick_key is distinct from old.pick_key
     or new.pick_label is distinct from old.pick_label or new.pick_odds is distinct from old.pick_odds
     or new.pick_section is distinct from old.pick_section or new.wager is distinct from old.wager
     or new.market is distinct from old.market or new.selection is distinct from old.selection
     or new.player is distinct from old.player or new.line_point is distinct from old.line_point
     or new.price is distinct from old.price or new.odds_book is distinct from old.odds_book
     or new.odds_captured_at is distinct from old.odds_captured_at
     or new.simulation_id is distinct from old.simulation_id
     or new.model_edge is distinct from old.model_edge
     or new.sim_hit_rate is distinct from old.sim_hit_rate
     or new.sim_hits is distinct from old.sim_hits or new.sim_runs is distinct from old.sim_runs
     or new.created_at is distinct from old.created_at then
    raise exception 'A tailed bet is locked: its line, odds, sportsbook, timestamp and stake cannot change';
  end if;
  return new;
end $$;

-- One generator per game at a time, so concurrent Analyze clicks share one batch.
create table public.analysis_generation_locks (
  game_id uuid primary key references public.games(id) on delete cascade,
  locked_until timestamptz not null
);
grant all on public.analysis_generation_locks to service_role;
alter table public.analysis_generation_locks enable row level security;

create or replace function public.claim_analysis_generation(_game_id uuid, _seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare got boolean;
begin
  insert into public.analysis_generation_locks (game_id, locked_until)
  values (_game_id, now() + make_interval(secs => _seconds))
  on conflict (game_id) do update set locked_until = excluded.locked_until
    where public.analysis_generation_locks.locked_until < now()
  returning true into got;
  return coalesce(got, false);
end $$;
revoke execute on function public.claim_analysis_generation(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_analysis_generation(uuid, integer) to service_role;

-- Tail copies the exact displayed pick, from the exact batch the user saw.
drop function if exists public.tail_pick(uuid, text, numeric);
create or replace function public.tail_pick(_analysis_id uuid, _pick_key text, _stake numeric, _simulation_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  a public.game_analyses%rowtype;
  g public.games%rowtype;
  card jsonb;
  sim_id uuid;
  pick jsonb;
  section text;
  new_id uuid;
  px integer;
  hits integer;
  runs integer;
begin
  if uid is null then raise exception 'Sign in to tail a pick'; end if;
  if _stake is null or _stake <= 0 or _stake > 1000000 then
    raise exception 'Enter a stake greater than $0';
  end if;
  select * into a from public.game_analyses where id = _analysis_id;
  if not found then raise exception 'That Lock Lab analysis no longer exists'; end if;
  select * into g from public.games where id = a.game_id;
  if g.status <> 'scheduled' or g.commence_time <= now() then
    raise exception 'This game has started — picks can only be tailed before kickoff';
  end if;

  if _simulation_id is not null then
    select s.analysis_snapshot, s.id into card, sim_id from public.game_simulations s
     where s.id = _simulation_id and s.game_id = a.game_id and s.analysis_snapshot is not null;
    if card is null then raise exception 'That Lock Lab card is no longer available'; end if;
  else
    card := jsonb_build_object('top_bets', a.top_bets, 'player_props', a.player_props,
                               'fun_bets', a.fun_bets, 'odds_book', a.odds_book,
                               'odds_captured_at', a.odds_captured_at, 'generated_at', a.generated_at);
    sim_id := a.simulation_id;
  end if;

  section := 'top_bets';
  select x into pick from jsonb_array_elements(coalesce(card->'top_bets', '[]')) x where x->>'key' = _pick_key limit 1;
  if pick is null then
    section := 'player_props';
    select x into pick from jsonb_array_elements(coalesce(card->'player_props', '[]')) x where x->>'key' = _pick_key limit 1;
  end if;
  if pick is null then
    section := 'fun_bets';
    select x into pick from jsonb_array_elements(coalesce(card->'fun_bets', '[]')) x where x->>'key' = _pick_key limit 1;
  end if;
  if pick is null then raise exception 'That pick is not in this Lock Lab analysis'; end if;
  if jsonb_typeof(pick->'price') is distinct from 'number' then
    raise exception 'This pick has no posted sportsbook price, so it cannot be tailed';
  end if;
  px := round((pick->>'price')::numeric)::integer;
  runs := case when jsonb_typeof(pick->'simRuns') = 'number' then (pick->>'simRuns')::integer end;
  hits := case when jsonb_typeof(pick->'simHits') = 'array' then jsonb_array_length(pick->'simHits') end;

  if exists (
    select 1 from public.tails t
    where t.user_id = uid and t.game_id = a.game_id
      and t.pick_label = pick->>'label' and t.price = px
  ) then
    raise exception 'You already tailed this exact bet';
  end if;

  insert into public.tails (
    user_id, game_id, analysis_id, pick_key, pick_label, pick_odds, pick_section,
    bet_type, wager, extra_legs, market, selection, player, line_point, price,
    odds_book, odds_captured_at, simulation_id, model_edge, sim_hit_rate, sim_hits, sim_runs)
  values (
    uid, a.game_id, a.id, _pick_key, pick->>'label',
    coalesce(pick->>'odds', case when px > 0 then '+' || px else px::text end),
    section, 'straight', round(_stake, 2), '[]'::jsonb,
    pick->>'market', pick->>'selection', pick->>'player',
    case when jsonb_typeof(pick->'point') = 'number' then (pick->>'point')::numeric end,
    px, coalesce(pick->>'book', card->>'odds_book'),
    coalesce(nullif(pick->>'capturedAt', '')::timestamptz,
             nullif(card->>'odds_captured_at', '')::timestamptz,
             nullif(card->>'generated_at', '')::timestamptz),
    sim_id,
    case when jsonb_typeof(pick->'modelEdge') = 'number' then (pick->>'modelEdge')::numeric end,
    case when jsonb_typeof(pick->'simHitRate') = 'number' then (pick->>'simHitRate')::numeric
         when runs > 0 and hits is not null then round(hits::numeric / runs, 4) end,
    hits, runs)
  returning id into new_id;
  return new_id;
end $$;
revoke execute on function public.tail_pick(uuid, text, numeric, uuid) from public, anon;
grant execute on function public.tail_pick(uuid, text, numeric, uuid) to authenticated;