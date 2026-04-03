ALTER TABLE public.flowspex_missions
ADD COLUMN IF NOT EXISTS next_action TEXT;

COMMENT ON COLUMN public.flowspex_missions.next_action IS
'The single most important next step for this mission';
