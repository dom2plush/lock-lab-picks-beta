create or replace function public.ensure_profile(_uid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  u record;
  base text;
  candidate text;
  n int := 0;
begin
  if _uid is null or exists (select 1 from public.profiles where id = _uid) then return; end if;
  select id, email, raw_user_meta_data into u from auth.users where id = _uid;
  if not found then return; end if;
  base := lower(regexp_replace(coalesce(u.raw_user_meta_data->>'username', split_part(u.email, '@', 1)), '[^a-zA-Z0-9_]', '', 'g'));
  if base is null or length(base) < 3 then
    base := 'player' || substr(replace(u.id::text, '-', ''), 1, 6);
  end if;
  candidate := base;
  while exists (select 1 from public.profiles where lower(username) = candidate) loop
    n := n + 1;
    candidate := base || n::text;
  end loop;
  insert into public.profiles (id, username, display_name)
  values (u.id, candidate, coalesce(u.raw_user_meta_data->>'display_name', candidate))
  on conflict (id) do nothing;
end $$;
revoke execute on function public.ensure_profile(uuid) from public, anon, authenticated;

create or replace function public.tails_ensure_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.ensure_profile(new.user_id);
  return new;
end $$;
create trigger tails_ensure_profile before insert on public.tails
  for each row execute function public.tails_ensure_profile();
create trigger parlays_ensure_profile before insert on public.parlays
  for each row execute function public.tails_ensure_profile();