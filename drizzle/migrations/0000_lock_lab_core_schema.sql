-- ============ profiles ============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  display_name text,
  created_at timestamptz not null default now()
);
create unique index profiles_username_lower_idx on public.profiles (lower(username));

grant select on public.profiles to anon;
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

alter table public.profiles enable row level security;

create policy "profiles are publicly readable"
  on public.profiles for select to anon, authenticated using (true);
create policy "users insert own profile"
  on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "users update own profile"
  on public.profiles for update to authenticated using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)), '[^a-zA-Z0-9_]', '', 'g'));
  if base is null or length(base) < 3 then
    base := 'player' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;
  candidate := base;
  while exists (select 1 from public.profiles where lower(username) = candidate) loop
    n := n + 1;
    candidate := base || n::text;
  end loop;
  insert into public.profiles (id, username, display_name)
  values (new.id, candidate, coalesce(new.raw_user_meta_data->>'display_name', candidate));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ follows ============
create table public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint no_self_follow check (follower_id <> following_id)
);

grant select on public.follows to anon;
grant select, insert, delete on public.follows to authenticated;
grant all on public.follows to service_role;

alter table public.follows enable row level security;

create policy "follows are publicly readable"
  on public.follows for select to anon, authenticated using (true);
create policy "users manage own follows"
  on public.follows for insert to authenticated with check (auth.uid() = follower_id);
create policy "users remove own follows"
  on public.follows for delete to authenticated using (auth.uid() = follower_id);

-- ============ games ============
create table public.games (
  id uuid primary key default gen_random_uuid(),
  provider_game_id text not null,
  sport text not null check (sport in ('NFL','CFB')),
  home_team text not null,
  away_team text not null,
  home_team_short text,
  away_team_short text,
  commence_time timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','live','final')),
  home_score int,
  away_score int,
  odds jsonb not null default '{}'::jsonb,
  injuries jsonb not null default '[]'::jsonb,
  is_demo boolean not null default false,
  odds_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index games_provider_id_idx on public.games (sport, provider_game_id);
create index games_commence_idx on public.games (sport, commence_time);
create index games_status_idx on public.games (status);

grant select on public.games to anon;
grant select on public.games to authenticated;
grant all on public.games to service_role;

alter table public.games enable row level security;

create policy "games are publicly readable"
  on public.games for select to anon, authenticated using (true);

-- ============ game_analyses ============
create table public.game_analyses (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null unique references public.games(id) on delete cascade,
  sport text not null check (sport in ('NFL','CFB')),
  engine_version text not null default 'v1',
  generated_at timestamptz not null default now(),
  odds_snapshot jsonb not null default '{}'::jsonb,
  top_bets jsonb not null default '[]'::jsonb,
  bad_bet jsonb,
  fun_bets jsonb not null default '[]'::jsonb,
  player_props jsonb not null default '[]'::jsonb,
  top_pick_result text not null default 'pending' check (top_pick_result in ('pending','win','loss','push')),
  graded_at timestamptz
);
create index game_analyses_sport_idx on public.game_analyses (sport, top_pick_result);

grant select on public.game_analyses to anon;
grant select on public.game_analyses to authenticated;
grant all on public.game_analyses to service_role;

alter table public.game_analyses enable row level security;

create policy "analyses are publicly readable"
  on public.game_analyses for select to anon, authenticated using (true);

-- ============ tails ============
create table public.tails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  analysis_id uuid not null references public.game_analyses(id) on delete cascade,
  pick_key text not null,
  pick_label text not null,
  pick_odds text,
  pick_section text not null default 'top_bets',
  bet_type text not null default 'straight' check (bet_type in ('straight','parlay')),
  wager numeric(10,2),
  extra_legs jsonb not null default '[]'::jsonb,
  lock_leg_result text not null default 'pending' check (lock_leg_result in ('pending','win','loss','push')),
  created_at timestamptz not null default now()
);
create index tails_user_idx on public.tails (user_id, created_at desc);
create index tails_game_idx on public.tails (game_id);

grant select on public.tails to anon;
grant select, insert, update, delete on public.tails to authenticated;
grant all on public.tails to service_role;

alter table public.tails enable row level security;

create policy "tails are publicly readable"
  on public.tails for select to anon, authenticated using (true);
create policy "users insert own tails"
  on public.tails for insert to authenticated with check (auth.uid() = user_id);
create policy "users update own tails"
  on public.tails for update to authenticated using (auth.uid() = user_id);
create policy "users delete own tails"
  on public.tails for delete to authenticated using (auth.uid() = user_id);

-- ============ record + leaderboard views ============
create view public.lock_lab_records
with (security_invoker = on) as
select
  sport,
  count(*) filter (where top_pick_result = 'win')  as wins,
  count(*) filter (where top_pick_result = 'loss') as losses,
  count(*) filter (where top_pick_result = 'push') as pushes,
  count(*) filter (where top_pick_result = 'pending') as pending
from public.game_analyses
group by sport;

grant select on public.lock_lab_records to anon, authenticated;

create view public.leaderboard
with (security_invoker = on) as
select
  p.id as user_id,
  p.username,
  p.display_name,
  count(t.id) as total_tails,
  count(t.id) filter (where t.lock_leg_result = 'win')  as wins,
  count(t.id) filter (where t.lock_leg_result = 'loss') as losses,
  count(t.id) filter (where t.lock_leg_result = 'push') as pushes,
  count(t.id) filter (where t.lock_leg_result = 'pending') as pending,
  (select count(*) from public.follows f where f.following_id = p.id) as followers
from public.profiles p
left join public.tails t on t.user_id = p.id
group by p.id, p.username, p.display_name;

grant select on public.leaderboard to anon, authenticated;
