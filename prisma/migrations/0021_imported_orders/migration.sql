-- Historical imports are deliberately separate from operational orders/payments/stock.
CREATE TABLE public.imported_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 120),
  ordered_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, external_id)
);
CREATE INDEX imported_orders_business_date ON public.imported_orders(business_id, ordered_at DESC, id);
ALTER TABLE public.imported_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY imported_orders_members ON public.imported_orders TO authenticated
  USING (private.is_business_member(business_id))
  WITH CHECK (private.is_business_member(business_id));
GRANT SELECT, INSERT ON public.imported_orders TO authenticated;
GRANT ALL ON public.imported_orders TO service_role;
