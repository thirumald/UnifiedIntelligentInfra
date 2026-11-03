-- migrate:no-transaction
-- Continuous aggregates cannot be created inside a transaction block.
-- Real-time aggregation (materialized_only = false) merges the not-yet-
-- materialised tail so charts always include the latest readings.

CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1m
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 minute', time) AS bucket,
       tenant_id,
       device_id,
       metric,
       avg(value_num)        AS value_avg,
       min(value_num)        AS value_min,
       max(value_num)        AS value_max,
       last(value_num, time) AS value_last,
       count(*)              AS samples
FROM telemetry
WHERE value_num IS NOT NULL
GROUP BY 1, 2, 3, 4
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_1m',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);

-- Hierarchical aggregate on top of the 1-minute view (Timescale ≥ 2.9)
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket(INTERVAL '1 hour', bucket)           AS bucket,
       tenant_id,
       device_id,
       metric,
       sum(value_avg * samples) / NULLIF(sum(samples), 0) AS value_avg,
       min(value_min)                                     AS value_min,
       max(value_max)                                     AS value_max,
       last(value_last, bucket)                           AS value_last,
       sum(samples)                                       AS samples
FROM telemetry_1m
GROUP BY 1, 2, 3, 4
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_1h',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes',
  if_not_exists     => TRUE);

SELECT add_retention_policy('telemetry_1m', INTERVAL '180 days', if_not_exists => TRUE);
