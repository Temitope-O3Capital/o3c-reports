-- A dashboard is an ordered set of tiles, and every tile is a view of something that
-- already exists.
--
-- THE ONE DESIGN DECISION THAT MATTERS. A tile does not carry a query. It points at a
-- saved pivot report (app.pivot_reports) or a saved SQL query (app.bi_sql_queries), and
-- nothing else. That is deliberate and it is the whole architecture:
--
--   * Access control stays where it is already enforced and already tested. A pivot
--     report is gated by reportDatasetAllowed() — per-dataset department scoping — and a
--     saved SQL query is gated by the "reports" page, which is BI and admin only. If a
--     tile carried its own SQL, a dashboard would become a way to run anything under
--     whatever permission the dashboard happened to have, and every guard built in the
--     last two phases would be bypassable by saving a dashboard. The tile data endpoint
--     re-checks the VIEWER against the SOURCE on every read, not against the dashboard.
--   * One definition per number. The Report Builder and the SQL console already decide
--     what a figure means; a tile that re-expressed the query would be a second place
--     for the same fact to drift, which is the defect class this whole body of work has
--     been about.
--   * Phases 1 and 2 become the tile library for free. Nothing new to maintain.
--
-- WHY exactly-one-source IS A CHECK AND NOT A CONVENTION. Two nullable foreign keys with
-- "only set one" in a comment is how you get rows with both set, and then the renderer
-- has to pick — silently preferring one source over another. The constraint makes the
-- ambiguous row unwritable.
--
-- WHY ON DELETE CASCADE ON BOTH SOURCES. A tile cannot exist without its source: there
-- is no honest thing to render for a report that no longer exists, and the alternative
-- (SET NULL) would break the exactly-one CHECK anyway. The consequence is worth stating
-- plainly: deleting a shared saved report silently removes tiles from other people's
-- dashboards. That is a real hazard of sharing, not of this schema, and the dashboard
-- list surfaces a tile count so an emptied dashboard is visible.

BEGIN;

CREATE TABLE IF NOT EXISTS app.dashboards (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    -- is_shared, not is_public: shared means visible to anyone who can reach the
    -- dashboards page, which is the same "reports" grant the SQL console uses. It does
    -- NOT widen the data — each tile is still filtered by the viewer's own access to
    -- that tile's source, so a shared dashboard can legitimately render fewer tiles for
    -- one person than another.
    is_shared   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by  BIGINT      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app.dashboard_tiles (
    id           BIGSERIAL PRIMARY KEY,
    dashboard_id BIGINT      NOT NULL REFERENCES app.dashboards(id) ON DELETE CASCADE,

    -- An override only. Empty means "use the source's own name", so a renamed report
    -- renames its tiles instead of leaving a stale caption behind.
    title        TEXT        NOT NULL DEFAULT '',

    viz          TEXT        NOT NULL
                 CHECK (viz IN ('kpi', 'bar', 'line', 'area', 'donut', 'table')),

    source_report_id BIGINT REFERENCES app.pivot_reports(id)  ON DELETE CASCADE,
    source_sql_id    BIGINT REFERENCES app.bi_sql_queries(id) ON DELETE CASCADE,
    CONSTRAINT dashboard_tiles_exactly_one_source CHECK (
        (source_report_id IS NOT NULL AND source_sql_id IS NULL) OR
        (source_report_id IS NULL     AND source_sql_id IS NOT NULL)
    ),

    -- Grid position, in a 12-column grid. Rows are unbounded; h is in grid rows.
    -- Stored rather than derived because the user drags them, and a layout that
    -- rearranges itself on reload is not a layout.
    grid_x       INT         NOT NULL DEFAULT 0  CHECK (grid_x >= 0 AND grid_x < 12),
    grid_y       INT         NOT NULL DEFAULT 0  CHECK (grid_y >= 0),
    grid_w       INT         NOT NULL DEFAULT 6  CHECK (grid_w >= 1 AND grid_w <= 12),
    grid_h       INT         NOT NULL DEFAULT 4  CHECK (grid_h >= 1 AND grid_h <= 24),
    CONSTRAINT dashboard_tiles_fits_the_grid CHECK (grid_x + grid_w <= 12),

    -- Which column is the label and which is the value, plus per-viz options. Kept as
    -- JSONB because the choice is per-viz and a column named here may not exist until
    -- the source runs — the renderer falls back to the first text column and the first
    -- numeric one, so a tile added without configuration still draws something.
    config       JSONB       NOT NULL DEFAULT '{}'::jsonb,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list query is "mine, or shared", most recently touched first.
CREATE INDEX IF NOT EXISTS dashboards_owner_idx
    ON app.dashboards (created_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS dashboards_shared_idx
    ON app.dashboards (updated_at DESC) WHERE is_shared;

-- Tiles are always fetched for one dashboard, in grid order.
CREATE INDEX IF NOT EXISTS dashboard_tiles_board_idx
    ON app.dashboard_tiles (dashboard_id, grid_y, grid_x);

-- And "which dashboards break if I delete this report?" has to be answerable, because
-- the CASCADE above makes that question consequential.
CREATE INDEX IF NOT EXISTS dashboard_tiles_report_src_idx
    ON app.dashboard_tiles (source_report_id) WHERE source_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dashboard_tiles_sql_src_idx
    ON app.dashboard_tiles (source_sql_id) WHERE source_sql_id IS NOT NULL;

COMMIT;
