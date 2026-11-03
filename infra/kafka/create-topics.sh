#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Declarative Kafka topic bootstrap (idempotent — safe to re-run).
# Partition counts drive max consumer parallelism: worker replicas <= partitions.
# Messages are keyed by deviceId, so per-device ordering is preserved.
# -----------------------------------------------------------------------------
set -euo pipefail

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:29092}"
RF="${KAFKA_REPLICATION_FACTOR:-1}"
KT=/opt/kafka/bin/kafka-topics.sh

DAY_MS=86400000

create() {
  local topic="$1" partitions="$2"; shift 2
  local cfg=()
  for c in "$@"; do cfg+=(--config "$c"); done
  echo "→ ensuring topic ${topic} (partitions=${partitions}, rf=${RF})"
  "$KT" --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
        --topic "$topic" --partitions "$partitions" --replication-factor "$RF" "${cfg[@]}"
}

# Raw telemetry from ingest-bridge (high volume, short retention, lz4)
create "${TOPIC_TELEMETRY_RAW:-dt.telemetry.raw}" "${KAFKA_TELEMETRY_PARTITIONS:-12}" \
  "retention.ms=$((3 * DAY_MS))" "compression.type=lz4" "max.message.bytes=262144"

# Anomalies / threshold breaches emitted by the worker
create "${TOPIC_TELEMETRY_ANOMALIES:-dt.telemetry.anomalies}" 6 \
  "retention.ms=$((14 * DAY_MS))" "compression.type=lz4"

# Latest known state per device (compacted → instant rehydration on restart)
create "${TOPIC_DEVICE_STATE:-dt.device.state}" 6 \
  "cleanup.policy=compact" "min.compaction.lag.ms=60000" "segment.ms=3600000"

# Asset lifecycle events (CRUD from the API — audit / downstream sync)
create "${TOPIC_ASSET_EVENTS:-dt.asset.events}" 6 \
  "retention.ms=$((30 * DAY_MS))"

# Heavy background jobs (IFC parsing, GIS imports)
create "${TOPIC_IFC_JOBS:-dt.ifc.jobs}" 3 \
  "retention.ms=$((7 * DAY_MS))"

# Dead-letter queue for payloads failing schema validation
create "${TOPIC_TELEMETRY_DLQ:-dt.telemetry.dlq}" 3 \
  "retention.ms=$((30 * DAY_MS))"

echo "✔ topics ready:"
"$KT" --bootstrap-server "$BOOTSTRAP" --list
