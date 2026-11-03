#!/bin/sh
# Materialise the Mosquitto password file from environment variables at start-up
# so no credentials live in the repository or image.
set -eu

: "${MQTT_SERVICE_USERNAME:?}" "${MQTT_SERVICE_PASSWORD:?}"
: "${MQTT_DEVICE_USERNAME:?}"  "${MQTT_DEVICE_PASSWORD:?}"

PWFILE=/mosquitto/data/passwd
rm -f "$PWFILE"
mosquitto_passwd -b -c "$PWFILE" "$MQTT_SERVICE_USERNAME" "$MQTT_SERVICE_PASSWORD"
mosquitto_passwd -b    "$PWFILE" "$MQTT_DEVICE_USERNAME"  "$MQTT_DEVICE_PASSWORD"
chown mosquitto:mosquitto "$PWFILE"
chmod 0700 "$PWFILE"
chown -R mosquitto:mosquitto /mosquitto/data

exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
