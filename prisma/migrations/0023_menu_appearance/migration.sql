-- Public appearance and private drafts are physically separate: anon cannot read drafts.
ALTER TABLE public.businesses ADD COLUMN menu_appearance jsonb;
ALTER TABLE public.businesses ADD CONSTRAINT businesses_menu_appearance_object CHECK (menu_appearance IS NULL OR jsonb_typeof(menu_appearance) = 'object');
CREATE TABLE public.menu_appearance_drafts (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
ALTER TABLE public.menu_appearance_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.menu_appearance_drafts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.menu_appearance_drafts TO authenticated, service_role;
CREATE POLICY menu_appearance_read ON public.menu_appearance_drafts FOR SELECT TO authenticated
  USING (private.is_business_member(business_id));
CREATE POLICY menu_appearance_admin ON public.menu_appearance_drafts FOR ALL TO authenticated
  USING (private.has_business_role(business_id, ARRAY['owner','admin']::public.business_role[]))
  WITH CHECK (private.has_business_role(business_id, ARRAY['owner','admin']::public.business_role[]));
