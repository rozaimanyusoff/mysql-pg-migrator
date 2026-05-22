-- ============================================================
-- DB Maintenance Tools — Flow-to-Database Designer
-- Migration: 006_flow_designer
-- ============================================================

CREATE TABLE IF NOT EXISTS dbt_ftd_projects (
  id          BIGSERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  domain      VARCHAR(100),
  schema_name VARCHAR(63)  NOT NULL DEFAULT 'app',
  status      VARCHAR(30)  NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Business flow nodes
CREATE TABLE IF NOT EXISTS dbt_ftd_nodes (
  id         VARCHAR(50) NOT NULL,
  project_id BIGINT      NOT NULL REFERENCES dbt_ftd_projects(id) ON DELETE CASCADE,
  node_type  VARCHAR(30) NOT NULL,   -- start | process | decision | approval | data_object | end
  label      VARCHAR(255) NOT NULL,
  position_x FLOAT       NOT NULL DEFAULT 0,
  position_y FLOAT       NOT NULL DEFAULT 0,
  metadata   JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, project_id)
);

-- Business flow edges (connections between nodes)
CREATE TABLE IF NOT EXISTS dbt_ftd_edges (
  id         VARCHAR(50) NOT NULL,
  project_id BIGINT      NOT NULL REFERENCES dbt_ftd_projects(id) ON DELETE CASCADE,
  source_id  VARCHAR(50) NOT NULL,
  target_id  VARCHAR(50) NOT NULL,
  label      VARCHAR(255),
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, project_id)
);

-- Generated data flows (one per analyzed node)
CREATE TABLE IF NOT EXISTS dbt_ftd_data_flows (
  id               BIGSERIAL PRIMARY KEY,
  project_id       BIGINT       NOT NULL REFERENCES dbt_ftd_projects(id) ON DELETE CASCADE,
  node_id          VARCHAR(50),
  node_label       VARCHAR(255),
  business_object  VARCHAR(255),
  operation        VARCHAR(50),
  data_created     JSONB        NOT NULL DEFAULT '[]',
  data_updated     JSONB        NOT NULL DEFAULT '[]',
  data_referenced  JSONB        NOT NULL DEFAULT '[]',
  data_deleted     JSONB        NOT NULL DEFAULT '[]',
  status_before    VARCHAR(100),
  status_after     VARCHAR(100),
  actor            VARCHAR(255),
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  generated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ftd_data_flows_project
  ON dbt_ftd_data_flows (project_id, sort_order);

-- Candidate entities (tables)
CREATE TABLE IF NOT EXISTS dbt_ftd_entities (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT       NOT NULL REFERENCES dbt_ftd_projects(id) ON DELETE CASCADE,
  table_name   VARCHAR(100) NOT NULL,
  display_name VARCHAR(255),
  category     VARCHAR(50)  NOT NULL DEFAULT 'transaction',
  description  TEXT,
  schema_name  VARCHAR(63)  NOT NULL DEFAULT 'app',
  confirmed    BOOLEAN      NOT NULL DEFAULT false,
  rejected     BOOLEAN      NOT NULL DEFAULT false,
  fields       JSONB        NOT NULL DEFAULT '[]',
  source_nodes JSONB        NOT NULL DEFAULT '[]',
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, table_name)
);

CREATE INDEX IF NOT EXISTS idx_ftd_entities_project
  ON dbt_ftd_entities (project_id, sort_order);

-- Suggested relationships between entities
CREATE TABLE IF NOT EXISTS dbt_ftd_relationships (
  id                 BIGSERIAL PRIMARY KEY,
  project_id         BIGINT       NOT NULL REFERENCES dbt_ftd_projects(id) ON DELETE CASCADE,
  source_entity      VARCHAR(100) NOT NULL,
  target_entity      VARCHAR(100) NOT NULL,
  relationship_type  VARCHAR(30)  NOT NULL DEFAULT 'one_to_many',
  cardinality        VARCHAR(30)  NOT NULL DEFAULT 'optional',
  label              VARCHAR(255),
  foreign_key_column VARCHAR(100),
  confirmed          BOOLEAN      NOT NULL DEFAULT false,
  rejected           BOOLEAN      NOT NULL DEFAULT false,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Generated outputs (versioned DDL, Drizzle schema, data dictionary)
CREATE TABLE IF NOT EXISTS dbt_ftd_outputs (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT      NOT NULL REFERENCES dbt_ftd_projects(id) ON DELETE CASCADE,
  output_type VARCHAR(30) NOT NULL,   -- ddl | drizzle | dictionary_json
  content     TEXT        NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ftd_outputs_project_type
  ON dbt_ftd_outputs (project_id, output_type, version DESC);

-- Validation issues
CREATE TABLE IF NOT EXISTS dbt_ftd_validations (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT      NOT NULL REFERENCES dbt_ftd_projects(id) ON DELETE CASCADE,
  severity    VARCHAR(20) NOT NULL DEFAULT 'warning',
  category    VARCHAR(50),
  message     TEXT        NOT NULL,
  entity_name VARCHAR(100),
  field_name  VARCHAR(100),
  resolved    BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO dbt_migrations (name) VALUES ('006_flow_designer')
  ON CONFLICT (name) DO NOTHING;
