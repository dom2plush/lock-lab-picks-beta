DROP POLICY IF EXISTS "Signed-in users can add public betting inputs" ON public.public_betting_inputs;
DROP POLICY IF EXISTS "Signed-in users can update public betting inputs" ON public.public_betting_inputs;
DROP POLICY IF EXISTS "Signed-in users can clear public betting inputs" ON public.public_betting_inputs;
REVOKE INSERT, UPDATE, DELETE ON public.public_betting_inputs FROM authenticated;
GRANT ALL ON public.public_betting_inputs TO service_role;
COMMENT ON TABLE public.public_betting_inputs IS 'Public betting splits retrieved automatically from the Action Network feed during odds sync. Home side / over percentages.';