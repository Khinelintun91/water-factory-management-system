-- bootstrap_owner.sql — run AFTER apply_all.sql and AFTER creating the
-- first auth user in the dashboard (Authentication -> Users -> Add user,
-- email: owner@waterfactory.local, password: the owner's PIN, confirmed).
-- Replace the UUID below with that user's UUID (shown in the Users list).

insert into profiles (id, username, role)
values ('PASTE-UUID-HERE', 'owner', 'owner');
