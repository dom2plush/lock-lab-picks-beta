-- Simulation batches: server-only
DROP POLICY IF EXISTS "simulations are publicly readable" ON public.game_simulations;
REVOKE SELECT ON public.game_simulations FROM anon, authenticated;
GRANT ALL ON public.game_simulations TO service_role;

-- Games: only real (non-demo) games are public
DROP POLICY IF EXISTS "games are publicly readable" ON public.games;
CREATE POLICY "live games are publicly readable" ON public.games
  FOR SELECT TO anon, authenticated USING (is_demo = false);

-- Analyses: only for real games
DROP POLICY IF EXISTS "analyses are publicly readable" ON public.game_analyses;
CREATE POLICY "analyses of live games are publicly readable" ON public.game_analyses
  FOR SELECT TO anon, authenticated
  USING (EXISTS (SELECT 1 FROM public.games g WHERE g.id = game_analyses.game_id AND g.is_demo = false));

-- Tails: owner only
DROP POLICY IF EXISTS "tails are publicly readable" ON public.tails;
REVOKE SELECT ON public.tails FROM anon;
CREATE POLICY "users read own tails" ON public.tails
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Follows: only the two people involved
DROP POLICY IF EXISTS "follows are publicly readable" ON public.follows;
REVOKE SELECT ON public.follows FROM anon;
CREATE POLICY "users read own follows" ON public.follows
  FOR SELECT TO authenticated USING (auth.uid() = follower_id OR auth.uid() = following_id);

-- Profiles: own profile only
DROP POLICY IF EXISTS "profiles are publicly readable" ON public.profiles;
REVOKE SELECT ON public.profiles FROM anon;
CREATE POLICY "users read own profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

-- Leaderboard keeps showing public aggregates (username + counts only)
ALTER VIEW public.leaderboard SET (security_invoker = off);
GRANT SELECT ON public.leaderboard TO anon, authenticated;