-- Existing bot_settings RLS and updated_at trigger also protect these fields.
-- Keep all existing capabilities enabled during the migration.
ALTER TABLE public.bot_settings
  ADD COLUMN instructions text NOT NULL DEFAULT '',
  ADD COLUMN business_context text NOT NULL DEFAULT '',
  ADD COLUMN enabled_tools text[] NOT NULL DEFAULT ARRAY[
    'create_orders', 'order_status', 'modify_orders', 'cancel_orders', 'payment_proofs', 'refund_details'
  ]::text[],
  ADD CONSTRAINT bot_instructions_length CHECK (char_length(instructions) <= 8000),
  ADD CONSTRAINT bot_business_context_length CHECK (char_length(business_context) <= 12000),
  ADD CONSTRAINT bot_enabled_tools_known CHECK (
    enabled_tools <@ ARRAY['create_orders', 'order_status', 'modify_orders', 'cancel_orders', 'payment_proofs', 'refund_details']::text[]
    AND array_position(enabled_tools, NULL) IS NULL
    AND cardinality(enabled_tools) <= 6
  );
