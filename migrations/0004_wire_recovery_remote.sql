-- Sign-in recovery + existing wire.com account support.
--
-- reset_*    : local password-reset codes (the demo-inbox flow mirrors the
--              activation-code pattern; 15-minute expiry like Wire's own 10–15m).
-- remote_*   : a row that mirrors an account living on wire.com's production
--              backend. The fork keeps its OWN session tokens locally (so every
--              auth middleware path stays identical) and stores Wire's access
--              token + zuid cookie here so directory/connection calls can be
--              proxied with the user's real identity. Tokens are only ever sent
--              back to prod-nginz-https.wire.com.

alter table wire_users add column if not exists reset_code       text;
alter table wire_users add column if not exists reset_expires    timestamptz;
alter table wire_users add column if not exists remote_host      text;
alter table wire_users add column if not exists remote_access    text;
alter table wire_users add column if not exists remote_cookie    text;
alter table wire_users add column if not exists remote_expires_at timestamptz;
