CREATE TABLE public.public_betting_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL UNIQUE REFERENCES public.games(id) ON DELETE CASCADE,
  spread_bet_pct numeric,
  spread_money_pct numeric,
  ml_bet_pct numeric,
  ml_money_pct numeric,
  total_bet_pct numeric,
  total_money_pct numeric,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

GRANT SELECT ON public.public_betting_inputs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_betting_inputs TO authenticated;
GRANT ALL ON public.public_betting_inputs TO service_role;

ALTER TABLE public.public_betting_inputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public betting inputs are readable by everyone"
ON public.public_betting_inputs FOR SELECT USING (true);

CREATE POLICY "Signed-in users can add public betting inputs"
ON public.public_betting_inputs FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Signed-in users can update public betting inputs"
ON public.public_betting_inputs FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Signed-in users can clear public betting inputs"
ON public.public_betting_inputs FOR DELETE TO authenticated USING (auth.uid() IS NOT NULL);