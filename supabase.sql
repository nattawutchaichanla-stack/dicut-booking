-- DI-CUT booking: run once in Supabase > SQL Editor
create extension if not exists btree_gist;

create table if not exists bookings (
  id          text primary key,
  date        text not null,              -- YYYY-MM-DD (Bangkok)
  start       int  not null,              -- minutes from midnight
  dur         int  not null,
  barber_id   text not null,
  status      text not null,              -- confirmed | inprogress | done | noshow | cancelled
  phone_key   text,                       -- digits only, for "my bookings" lookup
  data        jsonb not null,             -- full booking as the app sees it
  updated_at  bigint not null,
  -- the same barber can never have two active queues that overlap
  constraint no_overlap exclude using gist (
    barber_id with =, date with =, int4range(start, start + dur) with &&
  ) where (status in ('confirmed', 'inprogress'))
);
create index if not exists bookings_updated on bookings (updated_at);
create index if not exists bookings_date on bookings (date);
create index if not exists bookings_phone on bookings (phone_key);

create table if not exists staff (
  staff_id     text primary key,          -- 'owner' or barber id
  name         text,
  role         text,                      -- owner | barber
  line_user_id text,
  link_code    text unique,
  linked_at    timestamptz
);

create table if not exists kv (key text primary key, value jsonb);

-- customers who registered in the app or booked (one row per phone)
create table if not exists members (
  phone_key  text primary key,             -- digits only
  name       text not null,
  created_at bigint not null
);
create index if not exists members_created on members (created_at);

-- only the server (secret key) may read/write; the public anon key gets nothing
alter table bookings enable row level security;
alter table staff    enable row level security;
alter table kv       enable row level security;
alter table members  enable row level security;

-- public bucket for payment slips (file names are random)
insert into storage.buckets (id, name, public) values ('slips', 'slips', true) on conflict (id) do nothing;
