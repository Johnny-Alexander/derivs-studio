-- VEGALAB schema for Supabase / PostgreSQL.
--
-- Generated from the Alembic migrations via `alembic upgrade head --sql`
-- (offline mode); do not edit by hand — regenerate after adding a migration.
--
-- Revisions included:
--   001  initial schema (8 tables)
--   002  add pnl_attribution.hedge_pnl
--
-- Applying this file to a fresh database is equivalent to running
-- `alembic upgrade head` and stamps alembic_version at '002'.

BEGIN;

CREATE TABLE alembic_version (
    version_num VARCHAR(32) NOT NULL, 
    CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);

-- Running upgrade  -> 001

CREATE TABLE instruments (
    id SERIAL NOT NULL, 
    symbol VARCHAR(32) NOT NULL, 
    root VARCHAR(8) NOT NULL, 
    expiry DATE NOT NULL, 
    strike FLOAT NOT NULL, 
    "right" VARCHAR(1) NOT NULL, 
    PRIMARY KEY (id), 
    UNIQUE (symbol)
);

CREATE INDEX ix_instruments_expiry_strike ON instruments (expiry, strike);

CREATE TABLE seasons (
    id SERIAL NOT NULL, 
    name VARCHAR(64) NOT NULL, 
    starts_on DATE NOT NULL, 
    ends_on DATE, 
    is_active BOOLEAN NOT NULL, 
    PRIMARY KEY (id), 
    UNIQUE (name)
);

CREATE TABLE users (
    id SERIAL NOT NULL, 
    name VARCHAR(64) NOT NULL, 
    api_token VARCHAR(64) NOT NULL, 
    created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
    PRIMARY KEY (id), 
    UNIQUE (api_token), 
    UNIQUE (name)
);

CREATE TABLE accounts (
    id SERIAL NOT NULL, 
    user_id INTEGER NOT NULL, 
    season_id INTEGER NOT NULL, 
    starting_capital FLOAT NOT NULL, 
    cash FLOAT NOT NULL, 
    delta_hedge_notional FLOAT NOT NULL, 
    created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
    PRIMARY KEY (id), 
    FOREIGN KEY(season_id) REFERENCES seasons (id), 
    FOREIGN KEY(user_id) REFERENCES users (id), 
    CONSTRAINT uq_accounts_user_season UNIQUE (user_id, season_id)
);

CREATE TABLE market_snapshots (
    id SERIAL NOT NULL, 
    instrument_id INTEGER NOT NULL, 
    snapshot_ts TIMESTAMP WITH TIME ZONE NOT NULL, 
    bid FLOAT NOT NULL, 
    ask FLOAT NOT NULL, 
    mid FLOAT NOT NULL, 
    iv FLOAT NOT NULL, 
    delta FLOAT NOT NULL, 
    gamma FLOAT NOT NULL, 
    theta FLOAT NOT NULL, 
    vega FLOAT NOT NULL, 
    volume INTEGER NOT NULL, 
    open_interest INTEGER NOT NULL, 
    underlying_px FLOAT NOT NULL, 
    synthetic_quote BOOLEAN DEFAULT false NOT NULL, 
    fetched_at TIMESTAMP WITH TIME ZONE NOT NULL, 
    PRIMARY KEY (id), 
    FOREIGN KEY(instrument_id) REFERENCES instruments (id), 
    CONSTRAINT uq_snapshots_instrument_ts UNIQUE (instrument_id, snapshot_ts)
);

CREATE INDEX ix_market_snapshots_ts ON market_snapshots (snapshot_ts);

CREATE TABLE pnl_attribution (
    id SERIAL NOT NULL, 
    account_id INTEGER NOT NULL, 
    snapshot_ts TIMESTAMP WITH TIME ZONE NOT NULL, 
    delta_pnl FLOAT NOT NULL, 
    gamma_pnl FLOAT NOT NULL, 
    vega_pnl FLOAT NOT NULL, 
    theta_pnl FLOAT NOT NULL, 
    vanna_pnl FLOAT NOT NULL, 
    charm_pnl FLOAT NOT NULL, 
    volga_pnl FLOAT NOT NULL, 
    financing_pnl FLOAT NOT NULL, 
    residual_pnl FLOAT NOT NULL, 
    total_pnl FLOAT NOT NULL, 
    PRIMARY KEY (id), 
    FOREIGN KEY(account_id) REFERENCES accounts (id), 
    CONSTRAINT uq_attribution_account_ts UNIQUE (account_id, snapshot_ts)
);

CREATE TABLE positions (
    id SERIAL NOT NULL, 
    account_id INTEGER NOT NULL, 
    instrument_id INTEGER NOT NULL, 
    qty INTEGER NOT NULL, 
    avg_cost FLOAT NOT NULL, 
    realized_pnl FLOAT NOT NULL, 
    opened_at TIMESTAMP WITH TIME ZONE NOT NULL, 
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL, 
    PRIMARY KEY (id), 
    FOREIGN KEY(account_id) REFERENCES accounts (id), 
    FOREIGN KEY(instrument_id) REFERENCES instruments (id), 
    CONSTRAINT uq_positions_account_instrument UNIQUE (account_id, instrument_id)
);

CREATE TABLE trades (
    id SERIAL NOT NULL, 
    account_id INTEGER NOT NULL, 
    instrument_id INTEGER NOT NULL, 
    side VARCHAR(4) NOT NULL, 
    qty INTEGER NOT NULL, 
    fill_px FLOAT NOT NULL, 
    fill_quality VARCHAR(9) DEFAULT 'real' NOT NULL, 
    traded_at TIMESTAMP WITH TIME ZONE NOT NULL, 
    PRIMARY KEY (id), 
    FOREIGN KEY(account_id) REFERENCES accounts (id), 
    FOREIGN KEY(instrument_id) REFERENCES instruments (id)
);

CREATE INDEX ix_trades_account_traded_at ON trades (account_id, traded_at);

INSERT INTO alembic_version (version_num) VALUES ('001') RETURNING alembic_version.version_num;

-- Running upgrade 001 -> 002

ALTER TABLE pnl_attribution ADD COLUMN hedge_pnl FLOAT DEFAULT '0' NOT NULL;

UPDATE alembic_version SET version_num='002' WHERE alembic_version.version_num = '001';

COMMIT;

