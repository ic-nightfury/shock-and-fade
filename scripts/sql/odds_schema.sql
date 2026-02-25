-- Odds + Polymarket arb collector schema (Postgres)

create table if not exists odds_events (
  id serial primary key,
  provider_event_id text not null unique,
  sport_key text not null,
  commence_time timestamptz not null,
  home_team text not null,
  away_team text not null,
  created_at timestamptz default now()
);

create table if not exists odds_lines (
  id serial primary key,
  provider_event_id text not null,
  bookmaker text not null,
  home_odds numeric not null,
  away_odds numeric not null,
  ts timestamptz not null
);

create table if not exists poly_events (
  id serial primary key,
  market_slug text not null unique,
  sport text not null,
  game_start_time timestamptz,
  outcome_a text not null,
  outcome_b text not null,
  token_a text not null,
  token_b text not null,
  created_at timestamptz default now()
);

create table if not exists poly_books (
  id serial primary key,
  token_id text not null,
  ts timestamptz not null,
  best_bid numeric not null,
  best_ask numeric not null,
  vwap_buy numeric not null,
  vwap_sell numeric not null,
  size_shares numeric not null
);

create table if not exists edge_signals (
  id serial primary key,
  ts timestamptz not null,
  market_slug text not null,
  outcome text not null,
  token_id text not null,
  p_fair numeric not null,
  vwap_buy numeric not null,
  edge numeric not null,
  size_shares numeric not null,
  action text not null
);
