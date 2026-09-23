-- ===== Tails: exact locked snapshot of the Lock Lab bet =====
alter table public.tails
  add column if not exists market text,
  add column if not exists selection text,
  add column if not exists player text,
  add column if not exists line_point numeric,
  add column if not exists price integer,
  add column if not exists odds_book text,
  add column if not exists odds_captured_at timestamptz,
  add column if not exists graded_at timestamptz;

comment on column public.tails.extra_legs is 'DEPRECATED: manual legs are no longer accepted; parlays live in public.parlays';
comment on column public.tails.bet_type is 'DEPRECATED: every tail is a single; parlays live in public.parlays';

create or replace function public.american_to_decimal(_price numeric)
returns numeric language sql immutable set search_path = public as $$
  select case when _price is null or abs(_price) < 100 then null
              when _price > 0 then 1 + _price / 100.0
              else 1 + 100.0 / abs(_price) end
$$;

create or replace function public.grade_tail_result(
  _market text, _selection text, _point numeric,
  _home text, _away text, _hs integer, _as integer)
returns text language sql immutable set search_path = public as $$
  select case
    when _hs is null or _as is null then 'pending'
    when _market in ('Spread', 'Alternate spread') and _point is not null then
      case sign((case when _selection = _home then _hs - _as
                      when _selection = _away then _as - _hs end) + _point)
        when 0 then 'push' when 1 then 'win' when -1 then 'loss' else 'pending' end
    when _market in ('Total', 'Alternate total') and _point is not null
         and lower(_selection) in ('over', 'under') then
      case when _hs + _as = _point then 'push'
           when (lower(_selection) = 'over') = (_hs + _as > _point) then 'win'
           else 'loss' end
    when _market = 'Moneyline' then
      case when _hs = _as then 'push'
           when _selection = _home then case when _hs > _as then 'win' else 'loss' end
           when _selection = _away then case when _as > _hs then 'win' else 'loss' end
           else 'pending' end
    else 'pending' end
$$;

-- ===== Parlays =====
create table public.parlays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  stake numeric not null check (stake > 0),
  leg_count integer not null,
  computed_odds integer not null,
  actual_odds integer,
  actual_payout numeric,
  result text not null default 'pending' check (result in ('pending', 'win', 'loss', 'push')),
  settled_payout numeric,
  graded_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, delete on public.parlays to authenticated;
grant all on public.parlays to service_role;
alter table public.parlays enable row level security;
create policy "users read own parlays" on public.parlays
  for select to authenticated using (auth.uid() = user_id);
create index parlays_user_idx on public.parlays (user_id, created_at desc);

create table public.parlay_legs (
  id uuid primary key default gen_random_uuid(),
  parlay_id uuid not null references public.parlays(id) on delete cascade,
  tail_id uuid not null references public.tails(id) on delete restrict,
  leg_index integer not null,
  game_id uuid not null references public.games(id),
  pick_label text not null,
  pick_odds text,
  market text,
  selection text,
  player text,
  line_point numeric,
  price integer not null,
  odds_book text,
  odds_captured_at timestamptz,
  created_at timestamptz not null default now(),
  unique (parlay_id, tail_id)
);
grant select on public.parlay_legs to authenticated;
grant all on public.parlay_legs to service_role;
alter table public.parlay_legs enable row level security;
create policy "users read own parlay legs" on public.parlay_legs
  for select to authenticated
  using (exists (select 1 from public.parlays p where p.id = parlay_id and p.user_id = auth.uid()));
create index parlay_legs_tail_idx on public.parlay_legs (tail_id);

create policy "users delete own unstarted parlays" on public.parlays
  for delete to authenticated
  using (
    auth.uid() = user_id and result = 'pending'
    and not exists (
      select 1 from public.parlay_legs pl join public.games g on g.id = pl.game_id
      where pl.parlay_id = parlays.id and g.commence_time <= now()
    )
  );

-- ===== Tails are only created through tail_pick(); snapshots never change =====
revoke insert, update on public.tails from authenticated;
drop policy if exists "users insert own tails" on public.tails;
drop policy if exists "users update own tails" on public.tails;
drop policy if exists "users delete own tails" on public.tails;
create policy "users delete own unstarted tails" on public.tails
  for delete to authenticated
  using (
    auth.uid() = user_id and lock_leg_result = 'pending'
    and exists (select 1 from public.games g where g.id = tails.game_id and g.commence_time > now())
    and not exists (select 1 from public.parlay_legs pl where pl.tail_id = tails.id)
  );

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
     or new.created_at is distinct from old.created_at then
    raise exception 'A tailed bet is locked: its line, odds, sportsbook, timestamp and stake cannot change';
  end if;
  return new;
end $$;
create trigger tails_freeze_snapshot before update on public.tails
  for each row execute function public.tails_freeze_snapshot();

create or replace function public.parlays_freeze()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'parlay_legs' then
    raise exception 'Parlay legs are locked once placed';
  end if;
  if new.user_id is distinct from old.user_id or new.stake is distinct from old.stake
     or new.leg_count is distinct from old.leg_count or new.computed_odds is distinct from old.computed_odds
     or new.actual_odds is distinct from old.actual_odds or new.actual_payout is distinct from old.actual_payout
     or new.created_at is distinct from old.created_at then
    raise exception 'A parlay is locked: its legs, odds and stake cannot change';
  end if;
  return new;
end $$;
create trigger parlays_freeze before update on public.parlays
  for each row execute function public.parlays_freeze();
create trigger parlay_legs_freeze before update on public.parlay_legs
  for each row execute function public.parlays_freeze();

-- ===== Tail a Lock Lab pick (copies the exact stored bet) =====
create or replace function public.tail_pick(_analysis_id uuid, _pick_key text, _stake numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  a public.game_analyses%rowtype;
  g public.games%rowtype;
  pick jsonb;
  section text;
  new_id uuid;
  px integer;
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

  section := 'top_bets';
  select x into pick from jsonb_array_elements(a.top_bets) x where x->>'key' = _pick_key limit 1;
  if pick is null then
    section := 'player_props';
    select x into pick from jsonb_array_elements(a.player_props) x where x->>'key' = _pick_key limit 1;
  end if;
  if pick is null then
    section := 'fun_bets';
    select x into pick from jsonb_array_elements(a.fun_bets) x where x->>'key' = _pick_key limit 1;
  end if;
  if pick is null then raise exception 'That pick is not in the current Lock Lab analysis'; end if;
  if jsonb_typeof(pick->'price') is distinct from 'number' then
    raise exception 'This pick has no posted sportsbook price, so it cannot be tailed';
  end if;
  px := round((pick->>'price')::numeric)::integer;

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
    odds_book, odds_captured_at)
  values (
    uid, a.game_id, a.id, _pick_key, pick->>'label',
    coalesce(pick->>'odds', case when px > 0 then '+' || px else px::text end),
    section, 'straight', round(_stake, 2), '[]'::jsonb,
    pick->>'market', pick->>'selection', pick->>'player',
    case when jsonb_typeof(pick->'point') = 'number' then (pick->>'point')::numeric end,
    px, coalesce(pick->>'book', a.odds_book),
    coalesce(nullif(pick->>'capturedAt', '')::timestamptz, a.odds_captured_at, a.generated_at))
  returning id into new_id;
  return new_id;
end $$;
revoke execute on function public.tail_pick(uuid, text, numeric) from public, anon;
grant execute on function public.tail_pick(uuid, text, numeric) to authenticated;

-- ===== Grade a parlay from its tailed legs =====
create or replace function public.regrade_parlay(_parlay_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  p public.parlays%rowtype;
  n_win integer; n_loss integer; n_push integer; n_pend integer;
  dec numeric;
  payout numeric;
begin
  select * into p from public.parlays where id = _parlay_id;
  if not found or p.result <> 'pending' then return; end if;
  select count(*) filter (where t.lock_leg_result = 'win'),
         count(*) filter (where t.lock_leg_result = 'loss'),
         count(*) filter (where t.lock_leg_result = 'push'),
         count(*) filter (where t.lock_leg_result = 'pending'),
         exp(coalesce(sum(case when t.lock_leg_result = 'win'
                               then ln(public.american_to_decimal(pl.price)) else 0 end), 0))
    into n_win, n_loss, n_push, n_pend, dec
  from public.parlay_legs pl join public.tails t on t.id = pl.tail_id
  where pl.parlay_id = _parlay_id;

  if n_loss > 0 then
    update public.parlays set result = 'loss', settled_payout = 0, graded_at = now() where id = p.id;
  elsif n_pend > 0 then
    return;
  elsif n_win = 0 then
    update public.parlays set result = 'push', settled_payout = p.stake, graded_at = now() where id = p.id;
  else
    payout := case
      when n_push = 0 and p.actual_payout is not null then p.actual_payout
      when n_push = 0 and p.actual_odds is not null then p.stake * public.american_to_decimal(p.actual_odds)
      else p.stake * dec end;
    update public.parlays set result = 'win', settled_payout = round(payout, 2), graded_at = now() where id = p.id;
  end if;
end $$;
revoke execute on function public.regrade_parlay(uuid) from public, anon, authenticated;

create or replace function public.tails_regrade_parlays()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.lock_leg_result is distinct from old.lock_leg_result then
    perform public.regrade_parlay(pl.parlay_id) from public.parlay_legs pl where pl.tail_id = new.id;
  end if;
  return new;
end $$;
create trigger tails_regrade_parlays after update of lock_leg_result on public.tails
  for each row execute function public.tails_regrade_parlays();

-- ===== Grade tailed bets as soon as a final score lands =====
create or replace function public.games_grade_tails()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'final' and new.home_score is not null and new.away_score is not null then
    update public.tails t
       set lock_leg_result = r.res, graded_at = now()
      from (
        select id, public.grade_tail_result(market, selection, line_point, new.home_team,
                                            new.away_team, new.home_score, new.away_score) as res
        from public.tails where game_id = new.id and lock_leg_result = 'pending'
      ) r
     where t.id = r.id and r.res <> 'pending';
  end if;
  return new;
end $$;
create trigger games_grade_tails after insert or update of status, home_score, away_score on public.games
  for each row execute function public.games_grade_tails();

-- ===== Build a parlay from the user's own tailed bets =====
create or replace function public.create_parlay(
  _tail_ids uuid[], _stake numeric, _actual_odds integer default null, _actual_payout numeric default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  ids uuid[];
  n integer;
  owned integer;
  dec numeric;
  odds integer;
  new_id uuid;
begin
  if uid is null then raise exception 'Sign in to build a parlay'; end if;
  if _stake is null or _stake <= 0 or _stake > 1000000 then
    raise exception 'Enter a stake greater than $0';
  end if;
  select array_agg(distinct x) into ids from unnest(_tail_ids) x;
  n := coalesce(array_length(ids, 1), 0);
  if n < 2 or n > 12 then raise exception 'A parlay needs 2 to 12 of your tailed bets'; end if;

  select count(*), exp(sum(ln(public.american_to_decimal(t.price))))
    into owned, dec
  from public.tails t join public.games g on g.id = t.game_id
  where t.id = any(ids) and t.user_id = uid and t.lock_leg_result = 'pending'
    and t.price is not null and g.status = 'scheduled' and g.commence_time > now();
  if owned <> n then
    raise exception 'Parlay legs must be your own tailed bets on games that have not started';
  end if;

  if _actual_odds is not null and abs(_actual_odds) < 100 then
    raise exception 'Parlay odds must be American odds like +450 or -120';
  end if;
  if _actual_payout is not null and _actual_payout <= _stake then
    raise exception 'The payout must be more than the stake';
  end if;

  odds := case when dec >= 2 then round((dec - 1) * 100) else round(-100 / (dec - 1)) end;

  insert into public.parlays (user_id, stake, leg_count, computed_odds, actual_odds, actual_payout)
  values (uid, round(_stake, 2), n, odds, _actual_odds, round(_actual_payout, 2))
  returning id into new_id;

  insert into public.parlay_legs (parlay_id, tail_id, leg_index, game_id, pick_label, pick_odds,
    market, selection, player, line_point, price, odds_book, odds_captured_at)
  select new_id, t.id, row_number() over (order by g.commence_time, t.created_at), t.game_id,
         t.pick_label, t.pick_odds, t.market, t.selection, t.player, t.line_point, t.price,
         t.odds_book, t.odds_captured_at
  from public.tails t join public.games g on g.id = t.game_id
  where t.id = any(ids);
  return new_id;
end $$;
revoke execute on function public.create_parlay(uuid[], numeric, integer, numeric) from public, anon;
grant execute on function public.create_parlay(uuid[], numeric, integer, numeric) to authenticated;

-- ===== Official record: only tailed Lock Lab bets, computed in the database =====
create or replace function public.my_bet_record()
returns jsonb language sql stable security definer set search_path = public as $$
  with s as (
    select lock_leg_result as res, coalesce(wager, 0) as stake,
           public.american_to_decimal(price) as dec
    from public.tails where user_id = auth.uid()
  ),
  pr as (
    select result as res, stake,
           case when result = 'win' then settled_payout / stake end as dec
    from public.parlays where user_id = auth.uid()
  ),
  rows as (
    select 'singles' as kind, * from s
    union all select 'parlays', * from pr
    union all select 'combined', * from s
    union all select 'combined', * from pr
  ),
  agg as (
    select kind,
      count(*) filter (where res = 'win') as wins,
      count(*) filter (where res = 'loss') as losses,
      count(*) filter (where res = 'push') as pushes,
      count(*) filter (where res = 'pending') as pending,
      coalesce(sum(stake) filter (where res in ('win', 'loss', 'push')), 0) as staked,
      coalesce(sum(case when res = 'win' then stake * (dec - 1)
                        when res = 'loss' then -stake else 0 end), 0) as profit,
      coalesce(sum(case when res = 'win' then dec - 1
                        when res = 'loss' then -1 else 0 end), 0) as units
    from rows group by kind
  )
  select coalesce(jsonb_object_agg(k.kind, jsonb_build_object(
    'wins', coalesce(a.wins, 0), 'losses', coalesce(a.losses, 0),
    'pushes', coalesce(a.pushes, 0), 'pending', coalesce(a.pending, 0),
    'staked', round(coalesce(a.staked, 0), 2), 'profit', round(coalesce(a.profit, 0), 2),
    'units', round(coalesce(a.units, 0), 2),
    'winPct', case when coalesce(a.wins, 0) + coalesce(a.losses, 0) > 0
                   then round(a.wins::numeric / (a.wins + a.losses) * 100, 1) end,
    'roi', case when coalesce(a.staked, 0) > 0 then round(a.profit / a.staked * 100, 1) end
  )), '{}'::jsonb)
  from (values ('singles'), ('parlays'), ('combined')) k(kind)
  left join agg a on a.kind = k.kind
$$;
revoke execute on function public.my_bet_record() from public, anon;
grant execute on function public.my_bet_record() to authenticated;