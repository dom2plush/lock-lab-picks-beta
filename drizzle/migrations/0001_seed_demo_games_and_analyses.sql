-- Realistic demo schedule + graded history. Replaced automatically once a live odds key is connected.
insert into public.games (provider_game_id, sport, home_team, away_team, home_team_short, away_team_short, commence_time, status, odds, injuries, is_demo)
values
-- upcoming NFL
('demo-nfl-1','NFL','Kansas City Chiefs','Denver Broncos','KC','DEN', now() + interval '2 days',  'scheduled', '{"bookmaker":"DraftKings","spread":{"home":-6.5,"away":6.5,"homePrice":-110,"awayPrice":-110},"total":{"points":44.5,"overPrice":-105,"underPrice":-115},"moneyline":{"home":-285,"away":230}}', '[{"team":"Denver Broncos","player":"J. Franklin","status":"Questionable","note":"ankle"}]', true),
('demo-nfl-2','NFL','Philadelphia Eagles','Dallas Cowboys','PHI','DAL', now() + interval '2 days 3 hours', 'scheduled', '{"bookmaker":"FanDuel","spread":{"home":-3.0,"away":3.0,"homePrice":-115,"awayPrice":-105},"total":{"points":47.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-160,"away":136}}', '[]', true),
('demo-nfl-3','NFL','Buffalo Bills','Miami Dolphins','BUF','MIA', now() + interval '3 days', 'scheduled', '{"bookmaker":"DraftKings","spread":{"home":-7.5,"away":7.5,"homePrice":-108,"awayPrice":-112},"total":{"points":49.5,"overPrice":-112,"underPrice":-108},"moneyline":{"home":-330,"away":260}}', '[{"team":"Miami Dolphins","player":"T. Hill","status":"Probable","note":"wrist"}]', true),
('demo-nfl-4','NFL','San Francisco 49ers','Los Angeles Rams','SF','LAR', now() + interval '3 days 4 hours', 'scheduled', '{"bookmaker":"Caesars","spread":{"home":-4.5,"away":4.5,"homePrice":-105,"awayPrice":-115},"total":{"points":45.5,"overPrice":-108,"underPrice":-112},"moneyline":{"home":-205,"away":172}}', '[]', true),
('demo-nfl-5','NFL','Baltimore Ravens','Cincinnati Bengals','BAL','CIN', now() + interval '4 days', 'scheduled', '{"bookmaker":"FanDuel","spread":{"home":-2.5,"away":2.5,"homePrice":-110,"awayPrice":-110},"total":{"points":51.5,"overPrice":-105,"underPrice":-115},"moneyline":{"home":-140,"away":120}}', '[]', true),
('demo-nfl-6','NFL','Detroit Lions','Green Bay Packers','DET','GB', now() + interval '5 days', 'scheduled', '{"bookmaker":"DraftKings","spread":{"home":-3.5,"away":3.5,"homePrice":-112,"awayPrice":-108},"total":{"points":52.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-180,"away":152}}', '[]', true),
-- upcoming CFB
('demo-cfb-1','CFB','Georgia Bulldogs','Alabama Crimson Tide','UGA','ALA', now() + interval '2 days 6 hours', 'scheduled', '{"bookmaker":"DraftKings","spread":{"home":-5.5,"away":5.5,"homePrice":-110,"awayPrice":-110},"total":{"points":51.5,"overPrice":-108,"underPrice":-112},"moneyline":{"home":-215,"away":180}}', '[]', true),
('demo-cfb-2','CFB','Ohio State Buckeyes','Michigan Wolverines','OSU','MICH', now() + interval '3 days 2 hours', 'scheduled', '{"bookmaker":"FanDuel","spread":{"home":-8.5,"away":8.5,"homePrice":-105,"awayPrice":-115},"total":{"points":46.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-360,"away":285}}', '[{"team":"Michigan Wolverines","player":"D. Moore","status":"Out","note":"hamstring"}]', true),
('demo-cfb-3','CFB','Texas Longhorns','Oklahoma Sooners','TEX','OU', now() + interval '3 days 8 hours', 'scheduled', '{"bookmaker":"Caesars","spread":{"home":-10.5,"away":10.5,"homePrice":-108,"awayPrice":-112},"total":{"points":55.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-450,"away":345}}', '[]', true),
('demo-cfb-4','CFB','Oregon Ducks','Washington Huskies','ORE','WASH', now() + interval '4 days 5 hours', 'scheduled', '{"bookmaker":"DraftKings","spread":{"home":-13.5,"away":13.5,"homePrice":-112,"awayPrice":-108},"total":{"points":58.5,"overPrice":-105,"underPrice":-115},"moneyline":{"home":-650,"away":475}}', '[]', true),
('demo-cfb-5','CFB','LSU Tigers','Ole Miss Rebels','LSU','MISS', now() + interval '5 days 2 hours', 'scheduled', '{"bookmaker":"FanDuel","spread":{"home":-2.5,"away":2.5,"homePrice":-115,"awayPrice":-105},"total":{"points":60.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-138,"away":118}}', '[]', true),
('demo-cfb-6','CFB','Notre Dame Fighting Irish','USC Trojans','ND','USC', now() + interval '6 days', 'scheduled', '{"bookmaker":"DraftKings","spread":{"home":-6.0,"away":6.0,"homePrice":-110,"awayPrice":-110},"total":{"points":53.5,"overPrice":-108,"underPrice":-112},"moneyline":{"home":-240,"away":198}}', '[]', true),
-- completed NFL
('demo-nfl-p1','NFL','Kansas City Chiefs','Las Vegas Raiders','KC','LV', now() - interval '7 days', 'final', '{"bookmaker":"DraftKings","spread":{"home":-9.5,"away":9.5,"homePrice":-110,"awayPrice":-110},"total":{"points":42.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-420,"away":330}}', '[]', true),
('demo-nfl-p2','NFL','New York Jets','New England Patriots','NYJ','NE', now() - interval '8 days', 'final', '{"bookmaker":"FanDuel","spread":{"home":-3.5,"away":3.5,"homePrice":-108,"awayPrice":-112},"total":{"points":38.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-175,"away":148}}', '[]', true),
('demo-nfl-p3','NFL','Tampa Bay Buccaneers','Atlanta Falcons','TB','ATL', now() - interval '9 days', 'final', '{"bookmaker":"Caesars","spread":{"home":-2.5,"away":2.5,"homePrice":-110,"awayPrice":-110},"total":{"points":48.5,"overPrice":-105,"underPrice":-115},"moneyline":{"home":-142,"away":122}}', '[]', true),
('demo-nfl-p4','NFL','Seattle Seahawks','Arizona Cardinals','SEA','ARI', now() - interval '14 days', 'final', '{"bookmaker":"DraftKings","spread":{"home":-6.5,"away":6.5,"homePrice":-112,"awayPrice":-108},"total":{"points":45.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-270,"away":220}}', '[]', true),
('demo-nfl-p5','NFL','Minnesota Vikings','Chicago Bears','MIN','CHI', now() - interval '15 days', 'final', '{"bookmaker":"FanDuel","spread":{"home":-4.5,"away":4.5,"homePrice":-110,"awayPrice":-110},"total":{"points":43.5,"overPrice":-108,"underPrice":-112},"moneyline":{"home":-198,"away":166}}', '[]', true),
-- completed CFB
('demo-cfb-p1','CFB','Alabama Crimson Tide','Tennessee Volunteers','ALA','TENN', now() - interval '7 days 4 hours', 'final', '{"bookmaker":"DraftKings","spread":{"home":-7.5,"away":7.5,"homePrice":-110,"awayPrice":-110},"total":{"points":54.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-300,"away":240}}', '[]', true),
('demo-cfb-p2','CFB','Michigan Wolverines','Penn State Nittany Lions','MICH','PSU', now() - interval '8 days 3 hours', 'final', '{"bookmaker":"FanDuel","spread":{"home":-3.0,"away":3.0,"homePrice":-115,"awayPrice":-105},"total":{"points":44.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-158,"away":134}}', '[]', true),
('demo-cfb-p3','CFB','Oklahoma Sooners','Baylor Bears','OU','BAY', now() - interval '9 days 5 hours', 'final', '{"bookmaker":"Caesars","spread":{"home":-16.5,"away":16.5,"homePrice":-108,"awayPrice":-112},"total":{"points":57.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-800,"away":560}}', '[]', true),
('demo-cfb-p4','CFB','USC Trojans','UCLA Bruins','USC','UCLA', now() - interval '14 days 2 hours', 'final', '{"bookmaker":"DraftKings","spread":{"home":-5.5,"away":5.5,"homePrice":-110,"awayPrice":-110},"total":{"points":59.5,"overPrice":-105,"underPrice":-115},"moneyline":{"home":-220,"away":184}}', '[]', true),
('demo-cfb-p5','CFB','Florida State Seminoles','Clemson Tigers','FSU','CLEM', now() - interval '15 days 6 hours', 'final', '{"bookmaker":"FanDuel","spread":{"home":-1.5,"away":1.5,"homePrice":-110,"awayPrice":-110},"total":{"points":48.5,"overPrice":-110,"underPrice":-110},"moneyline":{"home":-124,"away":104}}', '[]', true);

-- final scores for completed games
update public.games set home_score = 31, away_score = 17 where provider_game_id = 'demo-nfl-p1';
update public.games set home_score = 20, away_score = 23 where provider_game_id = 'demo-nfl-p2';
update public.games set home_score = 27, away_score = 24 where provider_game_id = 'demo-nfl-p3';
update public.games set home_score = 34, away_score = 20 where provider_game_id = 'demo-nfl-p4';
update public.games set home_score = 21, away_score = 19 where provider_game_id = 'demo-nfl-p5';
update public.games set home_score = 38, away_score = 24 where provider_game_id = 'demo-cfb-p1';
update public.games set home_score = 17, away_score = 24 where provider_game_id = 'demo-cfb-p2';
update public.games set home_score = 49, away_score = 21 where provider_game_id = 'demo-cfb-p3';
update public.games set home_score = 28, away_score = 27 where provider_game_id = 'demo-cfb-p4';
update public.games set home_score = 24, away_score = 30 where provider_game_id = 'demo-cfb-p5';

-- pre-game Lock Lab analyses for the completed games, graded against the final score
insert into public.game_analyses (game_id, sport, odds_snapshot, top_bets, bad_bet, fun_bets, player_props, top_pick_result, graded_at, generated_at)
select
  g.id,
  g.sport,
  g.odds,
  jsonb_build_array(
    jsonb_build_object(
      'key','top1','rank',1,'badge','green',
      'label', g.home_team_short || ' ' || (g.odds->'spread'->>'home') || ' (' || (g.odds->'spread'->>'homePrice') || ')',
      'market','Spread','selection', g.home_team,'line', g.odds->'spread'->>'home','odds', g.odds->'spread'->>'homePrice','book', g.odds->>'bookmaker',
      'reason','Line value sat below our projected margin and the home side controlled the trench matchup all week.'
    ),
    jsonb_build_object(
      'key','top2','rank',2,'badge','yellow',
      'label','Under ' || (g.odds->'total'->>'points') || ' (' || (g.odds->'total'->>'underPrice') || ')',
      'market','Total','selection','Under','line', g.odds->'total'->>'points','odds', g.odds->'total'->>'underPrice','book', g.odds->>'bookmaker',
      'reason','Pace and early-down run rate pointed under the number, with weather a mild concern.'
    )
  ),
  jsonb_build_object(
    'key','bad','badge','red',
    'label', g.away_team_short || ' ML (' || (g.odds->'moneyline'->>'away') || ')',
    'reason','Priced on name value rather than form — no edge on either side once we shopped the number.',
    'oppositeLabel', g.home_team_short || ' ML (' || (g.odds->'moneyline'->>'home') || ')',
    'oppositeRecommended', false,
    'oppositeReason','The favourite is fairly priced, so the flip side is not a bet either.'
  ),
  '[]'::jsonb,
  '[]'::jsonb,
  case
    when (g.home_score - g.away_score) + (g.odds->'spread'->>'home')::numeric > 0 then 'win'
    when (g.home_score - g.away_score) + (g.odds->'spread'->>'home')::numeric = 0 then 'push'
    else 'loss'
  end,
  g.commence_time + interval '4 hours',
  g.commence_time - interval '1 day'
from public.games g
where g.status = 'final';
