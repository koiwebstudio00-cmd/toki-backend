CREATE TABLE auth.signup_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email extensions.citext NOT NULL,
  code_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);

ALTER TABLE auth.signup_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON auth.signup_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON auth.signup_invitations TO service_role;
