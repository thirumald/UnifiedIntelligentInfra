-- =============================================================================
--  Telemetry store (TimescaleDB)
--  Narrow "one row per reading" model: new metrics from new device classes
--  never require a schema change. Segment-by compression on
--  (tenant, device, metric) gives ~10–20× storage reduction on sensor data.
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS telemetry (
  time         TIMESTAMPTZ      NOT NULL,
  tenant_id    TEXT             NOT NULL,
  device_id    TEXT             NOT NULL,
  asset_id     UUID,
  metric       TEXT             NOT NULL,
  value_num    DOUBLE PRECISION,
  value_bool   BOOLEAN,
  value_text   TEXT,
  unit         TEXT,
  quality      SMALLINT         NOT NULL DEFAULT 0,   -- 0 good · 1 uncertain · 2 bad
  message_id   UUID             NOT NULL,
  received_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);

SELECT create_hypertable('telemetry', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

-- Idempotent ingestion: Kafka redelivery (at-least-once) cannot duplicate rows
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_dedupe_uq ON telemetry (message_id, metric, time);
-- Primary access path: one device/metric over a time range
CREATE INDEX IF NOT EXISTS telemetry_device_metric_time_idx ON telemetry (tenant_id, device_id, metric, time DESC);
CREATE INDEX IF NOT EXISTS telemetry_asset_time_idx ON telemetry (asset_id, time DESC) WHERE asset_id IS NOT NULL;

ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'tenant_id, device_id, metric',
  timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('telemetry', INTERVAL '{{TSDB_COMPRESS_AFTER_DAYS}} days', if_not_exists => TRUE);
SELECT add_retention_policy('telemetry',  INTERVAL '{{TSDB_RETENTION_DAYS}} days',      if_not_exists => TRUE);

-- -----------------------------------------------------------------------------
--  Anomalies — detected by the telemetry worker; acknowledged from the UI
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anomalies (
  time             TIMESTAMPTZ      NOT NULL,
  anomaly_id       UUID             NOT NULL,
  tenant_id        TEXT             NOT NULL,
  device_id        TEXT             NOT NULL,
  asset_id         UUID,
  metric           TEXT             NOT NULL,
  value            DOUBLE PRECISION NOT NULL,
  detector         TEXT             NOT NULL,
  severity         TEXT             NOT NULL CHECK (severity IN ('info','warning','critical')),
  threshold        DOUBLE PRECISION,
  message          TEXT             NOT NULL,
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  TEXT,
  resolved_at      TIMESTAMPTZ,
  PRIMARY KEY (anomaly_id, time)
);

SELECT create_hypertable('anomalies', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS anomalies_tenant_time_idx ON anomalies (tenant_id, time DESC);
CREATE INDEX IF NOT EXISTS anomalies_asset_time_idx  ON anomalies (asset_id, time DESC);
CREATE INDEX IF NOT EXISTS anomalies_open_idx        ON anomalies (tenant_id, time DESC) WHERE resolved_at IS NULL;
SELECT add_retention_policy('anomalies', INTERVAL '365 days', if_not_exists => TRUE);
