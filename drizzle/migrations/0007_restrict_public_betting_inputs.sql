DROP POLICY IF EXISTS "Public betting inputs are readable by everyone" ON public.public_betting_inputs;
REVOKE SELECT ON public.public_betting_inputs FROM anon, authenticated;
GRANT ALL ON public.public_betting_inputs TO service_role;