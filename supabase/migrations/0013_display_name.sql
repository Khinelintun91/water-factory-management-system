-- 0013: Optional Burmese display name for user accounts.
-- Login usernames stay Latin (they double as the internal auth email
-- <username>@waterfactory.local, which cannot contain Burmese script).
-- display_name is free text (Burmese welcome) and is what the UI shows
-- wherever a person's name appears; it falls back to the username.
alter table public.profiles add column if not exists display_name text;
