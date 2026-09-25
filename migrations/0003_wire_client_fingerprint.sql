-- Device identity fingerprint on the registered MLS client.
--
-- Kept in its own migration so it applies whether or not 0002_wire.sql has
-- already been applied to a live database (`add column if not exists` is a
-- no-op on a fresh database that runs 0002 first).
alter table wire_clients add column if not exists fingerprint text;
