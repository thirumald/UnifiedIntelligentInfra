-- =============================================================================
--  Asset registry — the spatial backbone of the digital twin
--  All geometry is WGS84 (SRID 4326). BIM placement is stored twice:
--    * as the IFC GlobalId (links to the federated model element), and
--    * as a local ENU offset in metres from the model origin,
--  so the same asset renders on the GIS map and inside the BIM viewport.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name) VALUES ('default', 'Default Tenant') ON CONFLICT DO NOTHING;

-- Shared trigger: maintain updated_at
CREATE OR REPLACE FUNCTION dt_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
--  BIM models (federated IFC models or schematic building envelopes)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bim_models (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- Geo-reference: model origin (0,0,0) placed on the globe
  origin         GEOMETRY(Point, 4326) NOT NULL,
  origin_alt_m   DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Rotation of model +Y axis from true north, clockwise degrees
  rotation_deg   DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Envelope used by the schematic renderer when no IFC geometry is loaded
  width_m        DOUBLE PRECISION NOT NULL DEFAULT 60,
  depth_m        DOUBLE PRECISION NOT NULL DEFAULT 40,
  storeys        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{name, elevation_m, height_m}]
  ifc_schema     TEXT,                                  -- IFC2X3 | IFC4 | IFC4X3
  file_path      TEXT,
  file_size      BIGINT,
  status         TEXT NOT NULL DEFAULT 'schematic'
                 CHECK (status IN ('schematic', 'uploaded', 'processing', 'ready', 'failed')),
  element_count  INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bim_models_tenant_idx ON bim_models (tenant_id);
CREATE INDEX IF NOT EXISTS bim_models_origin_gix ON bim_models USING GIST (origin);
DROP TRIGGER IF EXISTS bim_models_touch ON bim_models;
CREATE TRIGGER bim_models_touch BEFORE UPDATE ON bim_models
  FOR EACH ROW EXECUTE FUNCTION dt_touch_updated_at();

-- Elements extracted from an IFC file by the background parser
CREATE TABLE IF NOT EXISTS bim_elements (
  model_id    UUID NOT NULL REFERENCES bim_models(id) ON DELETE CASCADE,
  ifc_guid    CHAR(22) NOT NULL,
  express_id  INTEGER NOT NULL,
  ifc_class   TEXT NOT NULL,
  name        TEXT,
  storey      TEXT,
  PRIMARY KEY (model_id, ifc_guid)
);
CREATE INDEX IF NOT EXISTS bim_elements_class_idx ON bim_elements (model_id, ifc_class);

-- -----------------------------------------------------------------------------
--  Assets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id   TEXT,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN (
                  'hvac_unit','server_rack','network_switch','pdu','ups','cctv_camera','plc',
                  'scada_rtu','sensor','access_controller','streetlight','traffic_signal',
                  'building','floor','room','other')),
  domain        TEXT NOT NULL CHECK (domain IN ('it','ot','facility','safety','mobility')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','maintenance','decommissioned','planned')),
  parent_id     UUID REFERENCES assets(id) ON DELETE SET NULL,
  location      GEOMETRY(Point, 4326) NOT NULL,
  altitude_m    DOUBLE PRECISION,
  -- BIM placement
  bim_model_id  UUID REFERENCES bim_models(id) ON DELETE SET NULL,
  ifc_guid      CHAR(22),
  ifc_class     TEXT,
  local_x       DOUBLE PRECISION,
  local_y       DOUBLE PRECISION,
  local_z       DOUBLE PRECISION,
  storey        TEXT,
  -- Schema-less CMDB / vendor attributes
  attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assets_bim_complete CHECK (
    (bim_model_id IS NULL AND ifc_guid IS NULL)
    OR (bim_model_id IS NOT NULL AND ifc_guid IS NOT NULL
        AND local_x IS NOT NULL AND local_y IS NOT NULL AND local_z IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS assets_tenant_external_uq ON assets (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assets_model_guid_uq ON assets (bim_model_id, ifc_guid) WHERE bim_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_location_gix ON assets USING GIST (location);
-- Geography-cast index accelerates metre-based ST_DWithin "nearby" queries
CREATE INDEX IF NOT EXISTS assets_location_geog_gix ON assets USING GIST ((location::geography));
CREATE INDEX IF NOT EXISTS assets_tenant_type_idx ON assets (tenant_id, type);
CREATE INDEX IF NOT EXISTS assets_parent_idx ON assets (parent_id);
CREATE INDEX IF NOT EXISTS assets_attributes_gin ON assets USING GIN (attributes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS assets_tags_gin ON assets USING GIN (tags);
CREATE INDEX IF NOT EXISTS assets_name_trgm ON assets USING GIN (name gin_trgm_ops);
DROP TRIGGER IF EXISTS assets_touch ON assets;
CREATE TRIGGER assets_touch BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION dt_touch_updated_at();

-- -----------------------------------------------------------------------------
--  Dynamic schema mapping — adapt vendor / legacy OT payloads without code
--  mapping = { "timestampPath": "ts", "timestampUnit": "ms|s|iso",
--              "fields": [ { "path": "objects.ZN-T.presentValue",
--                            "metric": "temperature_c", "unit": "C",
--                            "scale": 0.1, "offset": 0, "type": "number" } ] }
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_schema_mappings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  protocol    TEXT NOT NULL DEFAULT 'json'
              CHECK (protocol IN ('json','bacnet','modbus','opcua','vendor')),
  mapping     JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
DROP TRIGGER IF EXISTS mappings_touch ON device_schema_mappings;
CREATE TRIGGER mappings_touch BEFORE UPDATE ON device_schema_mappings
  FOR EACH ROW EXECUTE FUNCTION dt_touch_updated_at();

-- -----------------------------------------------------------------------------
--  Devices — telemetry sources bound to assets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  asset_id           UUID REFERENCES assets(id) ON DELETE SET NULL,
  protocol           TEXT NOT NULL DEFAULT 'mqtt',
  schema_mapping_id  UUID REFERENCES device_schema_mappings(id) ON DELETE SET NULL,
  profile            TEXT,               -- simulator / device-class hint
  enabled            BOOLEAN NOT NULL DEFAULT true,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS devices_asset_idx ON devices (asset_id);
DROP TRIGGER IF EXISTS devices_touch ON devices;
CREATE TRIGGER devices_touch BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION dt_touch_updated_at();

-- -----------------------------------------------------------------------------
--  Alert rules — per asset (most specific) or per asset type
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id    UUID REFERENCES assets(id) ON DELETE CASCADE,
  asset_type  TEXT,
  metric      TEXT NOT NULL,
  warn_min    DOUBLE PRECISION,
  warn_max    DOUBLE PRECISION,
  crit_min    DOUBLE PRECISION,
  crit_max    DOUBLE PRECISION,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alert_rules_scope CHECK (asset_id IS NOT NULL OR asset_type IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_asset_uq ON alert_rules (tenant_id, asset_id, metric) WHERE asset_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_type_uq ON alert_rules (tenant_id, asset_type, metric) WHERE asset_id IS NULL;
DROP TRIGGER IF EXISTS alert_rules_touch ON alert_rules;
CREATE TRIGGER alert_rules_touch BEFORE UPDATE ON alert_rules
  FOR EACH ROW EXECUTE FUNCTION dt_touch_updated_at();

-- -----------------------------------------------------------------------------
--  Read model: device → asset resolution used by worker and realtime gateway
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_device_bindings AS
SELECT d.tenant_id,
       d.id                 AS device_id,
       d.asset_id,
       a.type               AS asset_type,
       a.name               AS asset_name,
       ST_X(a.location)     AS lon,
       ST_Y(a.location)     AS lat,
       d.profile,
       d.protocol,
       d.schema_mapping_id,
       m.mapping            AS schema_mapping,
       d.enabled
FROM devices d
LEFT JOIN assets a                  ON a.id = d.asset_id
LEFT JOIN device_schema_mappings m  ON m.id = d.schema_mapping_id;
