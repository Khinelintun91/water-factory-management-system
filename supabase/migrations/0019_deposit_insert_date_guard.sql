-- 0019_deposit_insert_date_guard.sql — Deposits join the insert-date guard.
--
-- 0004 guarded entries/payments/expenses/inventory but never agent_deposits,
-- while the agent-detail deposit form exposes a date picker — so any staff
-- user could insert a backdated deposit through the UI. This adds the same
-- guard_insert_today() trigger (with 0018's owner exception built in):
-- staff/manager inserts must be dated today (Asia/Yangon); the owner may
-- backdate. Month lock on deposits (0006) is unchanged and still binds all.

create trigger deposits_insert_today before insert on agent_deposits
  for each row execute function guard_insert_today('deposit_date');
