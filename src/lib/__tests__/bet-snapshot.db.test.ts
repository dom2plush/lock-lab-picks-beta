/**
 * Database-level check that logged and tailed Lock Lab bets are immutable.
 * Runs entirely inside one transaction that is rolled back, so it leaves no
 * data behind. Skipped when no database connection is available.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const DB_URL = process.env["SUPABASE_DB_URL"];

function hasPsql(): boolean {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SQL = String.raw`
\set ON_ERROR_STOP 1
begin;
select id as uid from public.profiles order by created_at limit 1 \gset

insert into public.games (id, provider_game_id, sport, home_team, away_team, commence_time, status, odds)
values ('00000000-0000-4000-8000-00000000a001', 'snapshot-test-evt', 'NFL', 'Green Bay Packers', 'Atlanta Falcons',
        now() + interval '3 days', 'scheduled',
        '{"bookmaker":"FanDuel","spread":{"home":-7,"away":7,"homePrice":-115,"awayPrice":-105}}');

insert into public.game_simulations (id, game_id, sport, input_fingerprint, engine_version, runs, simulations, aggregate, is_current, analysis_snapshot, input_snapshot)
values ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', 'NFL', 'fp-old', 'sim-test', 50,
        '[]', '{}', true,
        '{"odds_book":"FanDuel","odds_captured_at":"2026-09-23T03:00:00Z","generated_at":"2026-09-23T03:01:00Z",
          "top_bets":[{"key":"top1","label":"PACKE -7 (-115)","market":"Spread","selection":"Green Bay Packers","point":-7,"price":-115,"odds":"-115","book":"FanDuel","capturedAt":"2026-09-23T03:00:00Z","simRuns":50,"simHits":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30],"simHitRate":0.6,"modelEdge":0.0651},
                      {"key":"top2","label":"Under 43.5 (-110)","market":"Total","selection":"Under","point":43.5,"price":-110,"odds":"-110","book":"FanDuel","capturedAt":"2026-09-23T03:00:00Z","simRuns":50,"simHits":[1,2,3],"simHitRate":0.56,"modelEdge":0.036}],
          "player_props":[],"fun_bets":[]}',
        '{}');

insert into public.game_analyses (id, game_id, sport, simulation_id, odds_book, top_bets)
select '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000a001', 'NFL',
       '00000000-0000-4000-8000-00000000b001', 'FanDuel', analysis_snapshot->'top_bets'
from public.game_simulations where id = '00000000-0000-4000-8000-00000000b001';

-- Tail the displayed Packers -7 -115 as a signed-in user.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'uid', 'role', 'authenticated')::text, true);
select public.tail_pick('00000000-0000-4000-8000-00000000c001', 'top1', 25, '00000000-0000-4000-8000-00000000b001') as tail_id \gset
reset role;

-- The live market moves to -105 and a new batch/card replaces the current one.
update public.games set odds = jsonb_set(odds, '{spread,homePrice}', '-105')
 where id = '00000000-0000-4000-8000-00000000a001';
update public.game_simulations set is_current = false where id = '00000000-0000-4000-8000-00000000b001';
insert into public.game_simulations (id, game_id, sport, input_fingerprint, engine_version, runs, simulations, aggregate, is_current, analysis_snapshot)
values ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000a001', 'NFL', 'fp-new', 'sim-test', 50, '[]', '{}', true,
        '{"top_bets":[{"key":"top1","label":"PACKE -7 (-105)","market":"Spread","selection":"Green Bay Packers","point":-7,"price":-105}],"player_props":[],"fun_bets":[]}');
update public.game_analyses
   set top_bets = '[{"key":"top1","label":"PACKE -7 (-105)","market":"Spread","selection":"Green Bay Packers","point":-7,"price":-105}]',
       simulation_id = '00000000-0000-4000-8000-00000000b002'
 where id = '00000000-0000-4000-8000-00000000c001';

-- A user still looking at the OLD card tails its second pick: they get exactly what they saw.
set local role authenticated;
select public.tail_pick('00000000-0000-4000-8000-00000000c001', 'top2', 10, '00000000-0000-4000-8000-00000000b001') as tail2_id \gset
reset role;

do $$
declare t record; t2 record; s jsonb; blocked boolean;
begin
  select * into t from public.tails where pick_label like 'PACKE%' and game_id = '00000000-0000-4000-8000-00000000a001';
  if t.pick_label <> 'PACKE -7 (-115)' or t.price <> -115 or t.line_point <> -7 or t.odds_book <> 'FanDuel'
     or t.wager <> 25 or t.simulation_id <> '00000000-0000-4000-8000-00000000b001'
     or t.model_edge <> 0.0651 or t.sim_hit_rate <> 0.6 or t.sim_hits <> 30 or t.sim_runs <> 50
     or t.odds_captured_at <> '2026-09-23T03:00:00Z'::timestamptz then
    raise exception 'TAIL_CHANGED %', row_to_json(t);
  end if;

  select * into t2 from public.tails where pick_label like 'Under%' and game_id = '00000000-0000-4000-8000-00000000a001';
  if t2.price <> -110 or t2.simulation_id <> '00000000-0000-4000-8000-00000000b001' then
    raise exception 'OLD_CARD_TAIL_WRONG %', row_to_json(t2);
  end if;

  blocked := false;
  begin
    update public.tails set price = -105, pick_label = 'PACKE -7 (-105)' where id = t.id;
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'TAIL_EDIT_ALLOWED'; end if;

  select analysis_snapshot into s from public.game_simulations where id = '00000000-0000-4000-8000-00000000b001';
  if (s->'top_bets'->0->>'price')::int <> -115 then raise exception 'LOGGED_BATCH_CHANGED'; end if;

  blocked := false;
  begin
    update public.game_simulations set analysis_snapshot = '{}' where id = '00000000-0000-4000-8000-00000000b001';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'BATCH_EDIT_ALLOWED'; end if;

  raise notice 'ALL_OK';
end $$;
rollback;
`;

describe.skipIf(!DB_URL || !hasPsql())("logged and tailed bets are immutable (database)", () => {
  it("keeps Packers -7 -115 after the market moves to -105, and blocks edits", () => {
    const out = execFileSync("psql", [DB_URL!, "-X", "-q"], { input: SQL, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    expect(out).toBeDefined();
  });
});

describe.skipIf(!DB_URL || !hasPsql())("database test harness", () => {
  it("reports ALL_OK from the transactional checks", () => {
    let stderr = "";
    try {
      execFileSync("psql", [DB_URL!, "-X", "-q"], { input: SQL, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? error);
    }
    expect(stderr).toBe("");
  });
});
