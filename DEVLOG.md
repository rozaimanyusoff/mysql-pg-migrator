# DEVLOG — DB Maintenance Tools

---

## 2026-05-21
- **revision** — Schema Explorer: Styled XLSX export + UI polish
  - Refactored XLSX export (`src/pages/api/schema-explorer/export.ts`) with styled workbook: title row, generated timestamp, blue column headers, per-table group rows, alternating data row fill, and outer/inner borders via helper functions (`makeCell`, `setRange`, `THIN`, `MEDIUM`)
  - Column queries batched per connection (single query for all selected tables) instead of one query per table — improves perf on large selections; both PG and MySQL paths updated
  - UI updates in `src/pages/schema-explorer.tsx` and `src/styles/globals.css` to align with new export flow
  - Status: done

## 2026-05-21
- **revision** — Schema Designer: Fix Load job restore + remove duplicate Load buttons
  - `handleLoadJob` was silently skipping `setTables` if `parseSqlToTables` returned empty (two nested guards). Removed both guards — now always calls `setTables`, `setDesignerSchemas`, `setSelectedTableId`. Also clears `importParsed`/`selectedParsedId` and switches `designerMode` to `'create'` so loaded tables appear in the tree immediately
  - `JobRunCard`: removed Load button and row-level `onClick={() => onLoad(job)}` — historical run rows now only have the chevron to expand the execution log. Removed `onLoad` prop entirely
  - `JobGroupCard` call site updated: `<JobRunCard>` no longer passes `onLoad`. Top-level Load button on the group card remains as the single load entry point
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: Remove Execute tab, fix Save button visibility, fix Add Column/FK position
  - Removed Execute tab button and `ExecutePanel` render block; removed `activeTab` state, `ActiveTab` type, and `setActiveTab` calls — Execute function is fully handled by the header Execute button + modal
  - Toolbar bar replaces tab bar: shows "Designer" label with table count badge; Save/Execute buttons remain in header right
  - Save button condition widened: now shows when `tables.length > 0 || importParsed.length > 0` (was only `tables.length > 0`, missed import mode before merge)
  - Add Column button and FK Relationships section moved inside the `overflow-auto` scroll container, directly after `</table>` — they now sit immediately below the last column row instead of being fixed to the bottom of the panel
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: ColumnEditorPanel layout — Add Column moved to bottom-right, FK below
  - Removed `+ Add Column` button from the table header row (was between column count label and delete button)
  - Added `+ Add Column` as a right-aligned styled button (`flex justify-end`) in its own footer row, above FK Relationships section
  - Reordered bottom section: Add Column footer → border separator → FK Relationships (was FK → Add Column)
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: DDL Generator shows selected table's DDL; SQL import strip only when no table selected
  - Added `activeParsedTable`, `activeEditTable`, `activeEditTableDdl`, `tableDdlCopied` computed state to `SchemaDesignerInner`
  - Middle panel DDL strip: now shows `activeEditTable`'s DDL whenever any table (tree or parsed list) is selected — works in both create and import mode
  - SQL import strip: only rendered when `!activeEditTable && designerMode === 'import'`
  - Column editor replaced IIFE with direct `activeEditTable` reference; `onUpdate` and `onDeleteTable` route to parsed or main tables depending on `activeParsedTable`
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: Save/Execute in tab header, dirty tracking, schema assign modal, import strip light mode fix, job card cleanup
  - **Import strip dark bg fix**: changed content area from `bg-slate-950` to `bg-gray-50 dark:bg-slate-950`; all text/border/input colors updated to light/dark variants
  - **Save moved to tab header**: removed Save button from Saved Jobs panel; tab header now shows Save + Execute buttons when tables exist. Save turns amber (`border-amber-400 bg-amber-50`) when `loadedJob` is set and current DDL differs from saved state (`isDirty` via `useEffect`)
  - **Execute button**: appears in tab header after job is loaded (`loadedJob !== null`); opens `ExecuteJobModal` with the loaded job
  - **Dirty tracking**: `useEffect` compares `generateDDL(tables)` against `loadedJob.schema_sql`; `handleSaveJob` updates `loadedJob.schema_sql` to reset dirty flag
  - **Schema assign modal** (`SchemaAssignModal`): shown before `SaveJobModal` in import mode when any tables have `schema='public'`; user picks existing schema or enters new one; "Keep public" skips assignment
  - **Job cards**: `JobRunCard` and `JobGroupCard` — removed Run (Play) button; replaced group-level action with Load (FolderOpen); `onExecute` prop removed from both components and all call sites
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: parsed table list UX — no fixed height, clickable, column editor wired
  - Removed `maxHeight: 140` from parsed list; uses `sidebar-scroll overflow-y-auto` with natural flex height (no hard pixel cap)
  - Parsed table rows are now clickable — selected row highlights in emerald; sets `selectedParsedId` state
  - Column editor (below import strip in middle panel) renders the selected parsed table via `ColumnEditorPanel`, with full add/remove/edit column support before merging; updates go back to `importParsed` state via `handleUpdateParsedTable`; delete removes from `importParsed` and clears selection
  - Switching to Create mode or merging clears `selectedParsedId`
  - Empty state hint updates contextually for import mode (no tables vs tables present vs table selected)
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **remove** — Schema Designer: Import tab removed; function consolidated into Designer tab
  - Removed "Import" tab from tab bar (`ActiveTab` now `'designer' | 'execute'`) and removed `ImportPanel` render block
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: left panel mode toggle (Create / Import SQL), multi-source import in middle panel
  - Removed TABLES label from left panel header entirely; replaced with a segmented toggle: "Create" (manual schema → tables) vs "Import SQL"
  - Create mode: shows `+ Schema` and `+ Table` action buttons below toggle; `+ Table` disabled until a schema exists; DDL preview strip hidden — column editor full height
  - Import mode: 200px strip in middle panel shows source tabs (Paste SQL | .sql | CSV | XLSX) + context-sensitive upload/parse button. Content area changes per source: paste textarea, .sql upload dropzone, CSV upload + table name input, XLSX upload dropzone. All sources populate `importParsed` state
  - After parsing/uploading, parsed tables appear in left panel below a dashed "Parsed · N" separator with a Merge button. Merge calls `mergeTables()`, auto-registers schemas, clears state
  - Hover `+` on schema headers conditionally hidden in Import mode via `allowAddTable` prop
  - Fixed TypeScript errors: removed no-longer-valid `onAdd`/`onAddSchema` props from `TableTreePanel` call
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

## 2026-05-20
- **implement** — Schema Designer: 3-panel layout, disabled Add Table until schema exists, DDL in middle panel
  - Designer tab reestructured as 3 panels: Left (schema/table tree, w-56), Middle (DDL preview strip 188px + column editor flex-1), Right (Saved Jobs, collapsible with notch, w-72)
  - Right panel notch: 24px strip on left edge of panel, always visible, click to collapse/expand with ChevronRight/ChevronLeft icon and smooth width transition (`transition-all duration-200`)
  - DDL preview strip in middle panel: always-visible generated SQL (postgresql), auto-updates as tables change (`useMemo`), Copy + Download buttons; lifted state (`ddlText`, `ddlCopied`, `downloadDdl`, `copyDdl`, `groupedJobs`) into SchemaDesignerInner
  - Middle panel empty state: removed "Add a table to get started" + "Add Table" button. Shows contextual hint: create schema first → add table → select table
  - Left panel: `designerSchemas` initial state changed `['public']` → `[]`; "+ Table" button disabled with tooltip "Create a schema first (PostgreSQL standard)" when `schemas.length === 0`
  - Added `ChevronLeft` to lucide imports
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **fix** — Schema Explorer: Print/PNG from Export tab not working, ? Guide position + rewrite
  - Root cause: ERD canvas unmounts when switching tabs, so `captureRef.current` was null on Export tab. Fix: ERD section now always mounted — uses `absolute inset-0 invisible pointer-events-none` when not active tab (preserves DOM dimensions for html-to-image), vs `h-full flex flex-col` when active
  - ? Guide button moved from just-after-tabs to far right of tab bar using `ml-auto` wrapper that also holds the columns context; popover flipped to `right-0` since button is now at edge
  - Guide rewritten in English only; removed Malay text; Export tab entry updated to mention PNG and Print
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: XLSX styling, move Print/PNG to Export tab, fix PNG quality
  - XLSX export kini ada border (thin gray), title row (merged, blue bg, white bold 14pt), generated timestamp row, per-table group header (light blue bg), column header row (blue bg, white bold), alternating row fill, freeze panes — ditulis dengan `cellStyles: true`
  - Print & PNG dipindah dari canvas Export dropdown ke Export tab — Export tab kini ada section "Canvas Image" dengan paper size picker, orientation toggle, Print + Export PNG buttons
  - Canvas Export button dibuang sepenuhnya dari ERD Panel — Panel kini hanya ada Hand/Select toggle, Layout dropdown, dan Zoom pill
  - State `paperSize`, `orientation`, `capturing` dilift ke parent `SchemaExplorer`; ERDInner expose `triggerPng` dan `triggerPrint` via `captureRef` prop (mutable ref pattern — updated setiap render)
  - PNG quality fix: tambah `pixelRatio: 3` dalam `toPng()` call — hasilkan gambar 3× resolution, kandungan node tidak lagi kabur bila zoom in
  - Files: `src/pages/schema-explorer.tsx`, `src/pages/api/schema-explorer/export.ts`
  - Status: done

- **implement** — Schema Explorer: collapsible schema groups, hover scrollbar, search sticky, ? guide
  - Schema groups kini collapsible — chevron toggle (▶/▼) pada setiap schema header; checkbox kekal berfungsi (stopPropagation dari collapse toggle)
  - Search field pindah masuk ke dalam scroll area sebagai sticky header (`top-0 z-20`), schema header sticky pada `top-[38px]` supaya tidak overlap
  - Scrollbar left panel: hidden by default, muncul bila hover menggunakan `.sidebar-scroll` CSS class (`globals.css`)
  - Tab bar kini flush kiri (buang `px-4` outer div), columns context button tambah `pr-4` untuk spacing
  - Tambah `?` (HelpCircle) button sebelah tab buttons — buka popover guide penerangan cara guna Schema Explorer (5 section: Left Panel, Columns, ERD, Select-to-zoom, Export)
  - Buang `React.FC<any>` → `React.FC<{size:number}>` untuk type safety
  - Files: `src/pages/schema-explorer.tsx`, `src/styles/globals.css`
  - Status: done

- **fix** — Schema Explorer: XLSX single-sheet, combined export, auto-zoom bug fix
  - XLSX export diubah: satu query batch untuk semua tables → satu sheet "Schema Overview" (Schema|Table|Column|Type|Nullable|Default|PK|FK|Comment). Sebelum ni N queries + N sheets = lambat untuk schema besar
  - Canvas Export dropdown dikembangkan: kini ada dua section — "Canvas image" (Print/PNG, paper size, orientation) dan "Schema data" (SQL/XLSX toggle + Download button). ERDInner kini terima `exportFormat`, `setExportFormat`, `onExportData`, `exportingData` sebagai props
  - Export tab description dikemaskini: XLSX kini labelled "Schema Overview XLSX — Single sheet, all tables × columns"
  - Auto-zoom bug fix: `onSelectionChange` kini gunakan delay 80ms sebelum `fitView` + 400ms sebelum reset `selectMode` supaya XYFlow sempat compute selection bounds
  - Files: `src/pages/schema-explorer.tsx`, `src/pages/api/schema-explorer/export.ts`
  - Status: done

- **revision** — Schema Explorer: buang ERD header bar, pindah Panel ke top-left
  - Buang schema filter bar (Schema dropdown, "X visible", "Uncheck all") dari ERD tab
  - `visibleKeys` kini guna semua `erdTables` tanpa filter — buang state `erdSchemaFilter`/`setErdSchemaFilter`
  - Panel tukar dari `top-right` ke `top-left`, `items-end` → `items-start`
  - Export dropdown flip dari `right-0` ke `left-0` supaya tak tersembunyi diluar skrin
  - File: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: hover highlight merah, direction icons fix, zoom pill, select-to-zoom
  - Tukar warna highlight dari biru ke merah: border, ring, header TableNode, handle, edge line semua jadi merah masa hover
  - Direction icons diswap supaya match user expectation: ↓=LR (horizontal), ↑=RL, →=TB (menegak), ←=BT
  - Fit + Zoom digabung jadi satu pill: [−] [⊡ Fit] [+]
  - Toggle Hand/Select button sebelah Layout: `Hand` icon = pan mode, `MousePointer2` icon (biru) = select mode; dalam select mode, drag area pilih nodes → auto `fitView` ke nodes terpilih then balik ke pan mode
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **implement** — Schema Explorer: Layout dropdown enhanced + edge toggle + edge hover highlight
  - Layout button tukar jadi dropdown dengan 4 section: Algorithm (Hierarchical/Grid), Direction (LR/TB/RL/BT), Spacing (Compact/Normal/Loose), Sort (Default/Name/Columns/Connections)
  - Edge style toggle dalam Layout dropdown: Crow's foot ↔ Simple arrow — sync via `useEffect` pada `edgeStyle` state
  - Edge hover: `onEdgeMouseEnter`/`onEdgeMouseLeave` pada ReactFlow → `highlightedNodes` set via `HighlightCtx` context
  - `TableNode` baca `HighlightCtx` — border biru + ring glow bila edge hover
  - Floating tooltip muncul di cursor bila hover edge — tunjuk `sourceTable.fromCol → targetTable.toCol`
  - `computeHierarchicalLayout` diupdate: terima `dir`, `spacing`, `sort` params; support LR/TB/RL/BT; flip axis untuk RL/BT
  - Tambah `computeGridLayout` — square-root grid arrangement, sortable
  - `applyLayout` pass semua params secara langsung — button dalam dropdown trigger layout terus tanpa tutup menu
  - File: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: pindah zoom controls (+/-) ke bawah Fit button di top-right
  - Keluarkan `<Controls />` component (bottom-left) — gantikan dengan zoom buttons dalam Panel
  - Panel top-right kini `flex-col items-end`: row atas (Layout, Export, Fit), row bawah (ZoomIn | ZoomOut)
  - Tambah `zoomIn`, `zoomOut` dari `useReactFlow()` hook; tambah `ZoomIn`, `ZoomOut` icons dari lucide-react
  - File: `src/pages/schema-explorer.tsx`
  - Status: done

- **fix** — Schema Explorer: ReactFlow Controls dan MiniMap putih dalam dark mode
  - XYFlow Controls button guna `background: white` dari CSS mereka sendiri — tak ikut Tailwind dark mode
  - Tambah CSS override dalam `src/styles/globals.css` untuk `.react-flow__controls-button`, `.react-flow__controls`, `.react-flow__minimap`, `.react-flow__minimap-mask` bawah `html.dark`
  - Buang `!bg-white dark:!bg-slate-800` dari `<MiniMap>` — kini dikontrol sepenuhnya oleh CSS global
  - Files: `src/styles/globals.css`, `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Designer overhaul: connection-free design, PostgreSQL-only, execute via modal
  - Removed connection selector from page header — designer now works fully locally without any DB connection
  - PostgreSQL-only: removed all MySQL branching from `TableTreePanel`, `ColumnEditorPanel`, `NewTableDialog`, DDL generation
  - Schema/table creation always available — no longer gated behind a connected DB
  - `ExecutePanel` stripped of all connection UI; job history now shows a Play button per group/run
  - `JobRunCard` + `JobGroupCard` — added `onExecute` prop + Play icon button
  - Added `ExecuteJobModal` component — connection + database picker, DDL re-generation, execution log, saves a new run record on completion
  - `ImportPanel` — self-contained connection/db picker for "From DB" section
  - Removed dead code: `SchemaAnalysis` interface, `SchemaAnalysisBadge` component, `NewDbDialog` component, `analyzeSchemaSql` function, `MYSQL_TYPES` constant, `useRouter` import, `Terminal` + `AlertCircle` icons
  - Removed state: `selectedConnId`, `databases`, `selectedDb`, `loadingDbs`, `dbError`, `showNewDb`, `creatingDb`, `newDbError`, `executing`, `execLog`, `lastRunStatus`
  - File: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: load-and-resave flow
  - `handleLoadJob` now sets `loadedJob` state when a saved job is loaded into the designer
  - `SaveJobModal` accepts `defaultName` + `defaultDesc` props — pre-fills job name/description when a job is loaded, so user can save a revision under the same name without retyping
  - Modal shows an info banner when editing a loaded job; Save button label changes to "Save Revision" when the name matches the loaded job
  - File: `src/pages/schema-designer.tsx`
  - Status: done

## 2026-05-19
- **implement** — Migration module v2: full replacement for old multi-page migration flow
  - New lib layer `src/lib/migv2/`: `types.ts`, `type-map.ts`, `job-store.ts`, `run-store.ts`, `runner.ts`
  - Cross-DB support: MySQL ↔ PostgreSQL in both directions (source and target are independently configurable)
  - Serial → UUID conversion: deterministic UUID derived from `sha256(tableNamespace||sourceId)` — no pre-pass needed; FK columns resolved on-the-fly using `fkRef` config
  - Job management: save/load named jobs (JSON in `data/migv2/jobs/`); jobs store connection meta (no passwords) + full table map
  - Chunked streaming execution via advance loop (8s per advance, 500 rows/chunk); run state persisted to `data/migv2/runs/`
  - Rollback: DELETE by stored inserted PKs (up to 5K/table) or TRUNCATE fallback when overflow
  - Export to `migration.md`: full run report with table mapping, column details, rollback SQL
  - API routes under `src/pages/api/migv2/`: `tables.ts`, `columns.ts`, `jobs/index.ts`, `jobs/[id].ts`, `run/start.ts`, `run/advance.ts`, `run/status.ts`, `run/rollback.ts`, `export-md.ts`
  - Page `src/pages/migration.tsx` complete rewrite — connection panel (source + target), source table tree with schema grouping, column mapping editor (per-column type/conversion/FK-ref), Jobs tab, Execute tab with per-table progress bars + live log stream
  - `src/pages/mapping.tsx` and `src/pages/migrate.tsx` → redirect to `/migration`
  - `src/pages/index.tsx` nav card description updated
  - Status: done

- **implement** — Schema Explorer: full replacement for Schema Config module
  - New page `src/pages/schema-explorer.tsx` — connect to any PostgreSQL or MySQL DB; 3-panel layout (connection bar, schema/table tree, tabbed right panel)
  - Left panel: schema tree with table count, row count badges, per-table ERD toggle (Network icon), per-schema "add all to ERD" action, live search filter
  - Columns tab: full column table with type, nullable, default, PK/FK/UNI badges, FK reference, comment
  - ERD tab: `@xyflow/react` canvas with custom `TableNode` nodes (columns listed inline), animated FK edges, Controls + MiniMap + fit-view
  - Export tab: pick SQL (CREATE TABLE migration) or XLSX (data model, one sheet per table + summary); downloads via blob
  - API routes under `src/pages/api/schema-explorer/`: `schemas.ts`, `tables.ts`, `columns.ts`, `export.ts`
  - Shared connection helper `src/lib/explorer-db.ts` — `withPg` / `withMysql` wrappers for ad-hoc connections
  - `src/pages/schema-config.tsx` replaced with redirect to `/schema-explorer`
  - `src/pages/index.tsx` nav card updated (Schema Explorer, Network icon, new href)
  - Dependency added: `@xyflow/react`
  - Status: done

- **revision** — Schema Explorer ERD: solid crow's foot edges + hierarchical auto-layout
  - Replaced animated dashed edges with solid `CrowsFootEdge` (custom `BaseEdge` + inline SVG `<marker>`) using `markerUnits="userSpaceOnUse"` for zoom-stable symbols
  - One-to-many: crow's foot (fan) at source FK handle, single bar at target PK handle; one-to-one when FK column is unique
  - `computeHierarchicalLayout`: BFS reverse-FK traversal assigns depth levels (pure parents left, FK-holding children right); vertical spacing estimated from column count
  - Status: done

- **fix** — Schema Explorer ERD capture: export full canvas, exclude dialog overlay
  - `prepareCapture()` closes print dialog then calls `fitView({ duration: 0 })` before capture so the full schema fits in frame
  - `toPng` `filter` excludes `.react-flow__panel` elements; captures `.react-flow` container directly
  - Status: done

- **implement** — Schema Designer: new standalone page (replaces Schema Generator)
  - Page `src/pages/schema-designer.tsx` — full visual schema design tool supporting PostgreSQL & MySQL
  - Connection bar: select saved connection, pick or create a database (with "+ New DB" dialog)
  - **Designer tab**: left table tree (grouped by schema for PG, flat for MySQL) + right inline column editor table. Columns: Name, Type, Length, PK, NN, UQ, AI, Default, FK Reference, Comment. PK rows amber-tinted. Add/delete columns inline.
  - **Import tab** — four import methods:
    - From Database: load live schema via schema-explorer APIs, checkbox-select tables, import column definitions
    - From SQL: paste or upload `.sql`, client-side CREATE TABLE parser, table preview, merge into designer
    - From XLSX/Excel: file upload via existing `excel-parser`, sheet→table mapping, type inference
    - From CSV: file upload, table name input, header+type inference from sample rows
  - **Execute tab** (Schema Generator feature parity):
    - Top: DDL preview (dark terminal) with copy + download buttons
    - Bottom: Seed SQL textarea (dark terminal) — INSERT statements run after DDL; `SeedAnalysisBadge` popover shows rows/table + ID strategy
    - Right panel: connection info, Execute button (runs DDL + seed statements in order), execution log
    - Post-run status banner with "Save Job" shortcut → `SaveJobModal` (job name + description)
    - Job History section: grouped by job name (`JobGroupCard` → `JobRunCard`), expand/collapse, Load button restores tables + seed SQL + clears log, Retry for failed runs
  - SQL analysis badges: `SchemaAnalysisBadge` + `SeedAnalysisBadge` — click-to-open popover with full breakdown
  - Job persistence: reuses `dbt_schema_jobs` table + `/api/schema-generator/jobs` POST/GET endpoints
  - `SchemaJob` interface updated to include `schema_sql`/`seed_sql` fields; GET query expanded to return them
  - All imports use merge strategy: skip tables with duplicate schema.name, append new ones
  - DDL generator: full round-trip support — PG SERIAL types, MySQL AUTO_INCREMENT, FOREIGN KEY constraints, column comments, `CREATE SCHEMA IF NOT EXISTS` for non-public PG schemas
  - Client-side SQL parser: handles `CREATE TABLE [IF NOT EXISTS] [schema.]table (...)`, inline PK/UNIQUE/FK, table-level constraints, type aliases normalisation
  - API routes under `src/pages/api/schema-designer/`: `databases.ts`, `create-db.ts`, `execute.ts`
  - `src/pages/index.tsx` — Schema Designer card added (Columns icon)
  - `src/pages/db-setup.tsx` — replaced with redirect to `/schema-designer`
  - Status: done

- **remove** — Schema Generator tab removed from Schema Explorer
  - Removed `ActiveTab` value `'schema-gen'`; type is now `'columns' | 'erd' | 'export'`
  - Removed all Sg* component definitions, helper types/functions, schema-gen state block, tab button, tab JSX content, and schema-gen modals from `src/pages/schema-explorer.tsx`
  - Schema Generator will be implemented as a standalone page
  - Status: done

## 2026-05-20
- **implement** — Schema Designer: pgAdmin-like UX overhaul — hierarchical tree, FK picker, guide popover
  - **Navbar UX**: New Connection option inside connection dropdown (navigates to `/connections` via `useRouter`); "+ New Database…" option inside DB dropdown; PostgreSQL badge shown only for PG connections
  - **`TableTreePanel`**: hierarchical schema → table grouping for PG (schema headers with expand/collapse, per-schema hover "+" to add table); flat list for MySQL; FK/referenced icons on table rows; "New Schema" button (PG only) + "New Table" button in panel header
  - **`NewSchemaDialog`**: PG-only dialog, sanitizes name to lowercase alphanumeric; adds schema to `designerSchemas` state; DDL generator emits `CREATE SCHEMA IF NOT EXISTS` for non-public schemas at execute time
  - **`NewTableDialog`**: accepts `defaultSchema?` prop so per-schema "+" pre-fills the schema field
  - **`FkPickerModal`**: two-panel visual FK picker — left: table list, right: columns with PK/UQ icons; click column → sets FK as `table.column` and closes modal
  - **`ColumnEditorPanel`**: FK cell shows blue badge (click to reopen picker) + × to clear; "Set FK" button opens picker; relationship summary below column table (Outgoing FKs + Referenced by)
  - **`GuidePopover`**: self-contained English-language guide popover (click-outside closes, 430 px wide, scrollable, 7 sections: Workflow, Navbar, Designer Tab, Column Properties, FK Picker, Import, Execute); replaces old full-screen Malay modal
  - Removed `showGuide` state, old tab bar button, old `GuideModal`/`_GuideModal_UNUSED` function
  - Files affected: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Migration module: navbar redesign + saved-connection pickers for source/target
  - Removed manual `ConnForm` (host/port/user/pass inputs) and `EMPTY_CONN` constant; removed `Eye`, `EyeOff`, `Plug`, `Unplug` icon imports
  - Header redesigned to match other modules: sticky, `backdrop-blur`, title + subtitle left, breadcrumb + action buttons right
  - New connections bar: Source and Target each have a saved-connection dropdown (grouped by PG/MySQL) + a database dropdown; "+ New Connection →" option navigates to `/connections`
  - When a connection is selected → databases auto-loaded via `/api/schema-designer/databases`; when a database is selected → auto-connects (source: fetches tables; target: validates connection)
  - `connRowToMigConn(row, db): MigConn` helper builds the connection object from `ConnectionRow`; `srcConn`/`tgtConn` state updated automatically so start/advance/rollback functions are unchanged
  - `handleLoadJob` now restores `srcConnId`/`srcDb` and `tgtConnId`/`tgtDb` by matching job metadata against saved connections (host + username + type)
  - Files affected: `src/pages/migration.tsx`
  - Status: done

- **fix** — Migration: target schema/table pickers for MySQL→PG mapping
  - Added `tgtSchemas: string[]` and `tgtDefaultSchema: string` state
  - When target PG DB connects, `/api/migv2/tables` response is used to extract distinct schema names; defaults to `public` if present
  - Connections bar: PG-only schema `<select>` (styled blue) appears after the database dropdown once connected; selects the default schema for new table mappings
  - Per-table mapping editor: target schema field is a `<select>` dropdown (populated from `tgtSchemas`) when connected to PG; falls back to free-text `<input>` for MySQL or if schemas not loaded
  - `toggleTable`: target schema now defaults to `tgtDefaultSchema` (for PG targets) instead of copying the MySQL source schema/db name
  - Added `tgtTables: MigTableInfo[]` state; target table field uses `<input>` + `<datalist>` that lists existing tables in the selected target schema — filters dynamically as schema changes; allows typing a new table name
  - Files affected: `src/pages/migration.tsx`
  - Status: done

---

## 2026-04-10
- **implement** — Initial commit: MySQL to PostgreSQL migration tool
  - Base Next.js project scaffold
  - MySQL inspector (`src/lib/mysql-inspector.ts`) — list databases, inspect tables/columns/indexes/FKs
  - PostgreSQL migrator (`src/lib/postgres-migrator.ts`)
  - Migration executor & orchestrator (`src/lib/migration-executor.ts`, `src/lib/migration-orchestrator.ts`)
  - Status: done

---

## 2026-04-12
- **implement** — Complete migration workflow with template, logs, and phase orchestration
  - Migration phases: dry run → mapping → execute
  - Template save/load for migration configs
  - Phase log output per table
  - Status: done

- **fix** — Next.js route types import path
  - Updated `next-env.d.ts` route type references
  - Status: done

- **fix** — Restore file selection handling in footer bar
  - Refined file picker state for config/template restore
  - Status: done

- **implement** — Remove UUID default PK flow from phase 1/2; add remove-table dialog
  - Phase 1 & 2 no longer auto-assign UUID PKs
  - Added dialog to remove tables from migration scope
  - Status: done

- **implement** — `.gitignore` — ignore migration run snapshots and `tsbuildinfo`
  - Status: done

---

## 2026-04-14
- **implement** — Phase 4: allow rerun for selected completed tables
  - User can re-select and re-execute specific completed tables without full restart
  - Status: done

---

## 2026-04-17
- **implement** — Schema Config: UUID PK/FK generate flow with manual parent-child mappings
  - UI to configure which columns become UUIDs
  - Manual mapping editor for parent → child FK relationships
  - Status: done

---

## 2026-04-27
- **update** — General update commit (miscellaneous fixes)
  - Status: done

---

## 2026-05-18
- **implement** — Repository restructured to standard Next.js `src/` layout
  - `pages/` → `src/pages/`, `components/` → `src/components/`, `lib/` → `src/lib/`, `styles/` → `src/styles/`
  - `tsconfig.json` path alias updated: `"@/*": ["./src/*"]`
  - `tailwind.config.js` content paths updated
  - Status: done

- **implement** — JWT authentication (replaces DB-backed opaque sessions)
  - `src/lib/auth-store.ts` — `createAccessToken`, `verifyAccessToken`, `createTokens`, `refreshAccessToken`
  - Access token: short-lived JWT signed with `JWT_SECRET_KEY`, expiry from `JWT_EXPIRATION_TIME` (default 3600s)
  - Refresh token: opaque 64-char hex stored in `dbt_sessions`, expiry from `REFRESH_TOKEN_EXPIRATION_TIME` (default 86400s)
  - `src/lib/auth-context.tsx` — `AuthProvider` with auto-refresh scheduled 60s before expiry, client-side JWT decode
  - New API routes: `POST /api/auth/refresh`, `GET /api/auth/profile`
  - Updated: login, verify-otp, verify, logout, update-account APIs
  - Status: done

- **implement** — Settings page — Email Config + Audit Logs tabs
  - Email Config: SMTP form (host, port, username, password, from_email, from_name), SSL toggle, 2FA toggle, test connection
  - Audit Logs: file list with inline log viewer (Time, Level, Module, Action, Details columns)
  - Status: done

- **implement** — Login dialog — 2FA OTP step
  - 6-digit input with auto-advance, `Mail` icon header, back link
  - Triggered when login response returns `twoFactorRequired: true`
  - Status: done

- **implement** — Footer cleanup
  - Removed: Restore Config, Restore Template, Logs buttons
  - Kept: theme toggle, clock, copyright
  - Status: done

- **update** — Home screen module order & rename
  - Order: Schema Generator → Export & Import → Data Normalization → Schema Config → Migration
  - "DB Setup" renamed to "Schema Generator"
  - Status: done

- **implement** — Settings Account tab — email field
  - Display current email, allow update via `POST /api/auth/update-account`
  - Status: done

- **implement** — README.md created
  - Getting started, JWT secret generation, app structure tree with `src/` layout
  - Status: done

- **implement** — Schema Generator module (`/db-setup`)
  - Pick saved PostgreSQL connection (card picker)
  - Create new DB or select existing from dropdown
  - Upload/paste schema SQL and seed SQL with drag-and-drop
  - Files stored at `UPLOAD_DIR/schema-generator/{username}/{YYYY-MM-DD}/{hex}_{filename}`
  - Execute: schema first, then seed; combined log output
  - Schema SQL analysis badge — tables, indexes, FKs, extensions, enums, triggers (popover)
  - Seed SQL analysis badge — rows per table, ID strategy (uuid/sequential/mixed/none), public schema flag (popover)
  - After execution → SaveJobModal (job name required, description optional)
  - Job history per user in right panel, grouped by job name as sub-list (alter/patch runs)
  - Failed job click → reload full config (connection, target DB, schema SQL, seed SQL) for retry
  - Status: done

- **implement** — Schema Generator API + DB migration
  - `POST /api/pg-create-db` — create new PostgreSQL database via `Client` (outside transaction)
  - `POST /api/schema-generator/upload` — file storage endpoint
  - `GET/POST /api/schema-generator/jobs` — list & create job records
  - `GET /api/schema-generator/jobs/[id]` — fetch single job for config reload
  - `db/migrations/004_schema_jobs.sql` — `dbt_schema_jobs` table
  - Status: done

- **implement** — SQL execute with per-step rollback (`/api/sql-execute`)
  - Each SQL block wrapped in `BEGIN/COMMIT`; error triggers `ROLLBACK`
  - `CONCURRENTLY` keyword detected — runs outside transaction with `[NOTE]` warning
  - Response includes `rolledBack` flag and expanded log lines (`[FAIL]`, `[ROLLBACK]`, `[ERROR]`)
  - Log renderer: green=success, amber=rollback/note, red=error
  - Status: done

---

## 2026-05-20
- **revision** — Schema Explorer ERD: crow's foot edges, hierarchical auto-layout
  - Replaced animated dashed edges with solid crow's foot edges (`CrowsFootEdge` custom component)
  - Crow's foot notation: source (FK table) = bar + three diverging lines (many); target (referenced table) = single bar (one); one-to-one when FK column has `isUnique = true`
  - Uses `getSmoothStepPath` with `borderRadius: 12` for clean right-angle routing; `BaseEdge` + inline SVG `<defs>` markers with `markerUnits="userSpaceOnUse"` for consistent sizing at all zoom levels
  - `computeHierarchicalLayout()` pure function: BFS reverse-FK traversal — "pure parent" tables (only referenced, no FKs) placed leftmost; FK-holder tables placed right based on depth; vertical spacing estimated from column count
  - ERD canvas now auto-layouts on every connect (initial load via `useEffect`)
  - "Layout" button in ERD Panel re-runs the hierarchical layout on demand; `minZoom` lowered to 0.05 to allow full-schema view
  - `edgeTypes = { crowsFoot: CrowsFootEdge }` registered on `<ReactFlow>`
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **fix** — Schema Explorer ERD export: full canvas capture (no dialog overlay, fit all nodes)
  - `handlePng` / `handlePrint` now call `prepareCapture()` before capturing: closes dropdown, calls `fitView({ duration: 0, padding: 0.06 })`, waits 180ms for layout to settle
  - `capture()` passes `filter` to `toPng` to exclude `.react-flow__panel` elements (dialog, Controls, MiniMap) from the image
  - Previously the Export dropdown was still visible in the screenshot and off-screen nodes were not included
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **implement** — Schema Explorer: integrate Schema Generator as new tab
  - New `schema-gen` tab added to Schema Explorer tab bar (FileCode2 icon)
  - Shows PostgreSQL-only notice when connected to MySQL; connect-first prompt when disconnected
  - Context banner in tab shows active connection label + target database
  - All Schema Generator sub-components ported into `schema-explorer.tsx`: `SgPopover`, `SchemaAnalysisBadge`, `SeedAnalysisBadge`, `SgDragDropField`, `SgExcelImportCard`, `SgExcelPreviewModal`, `SgSaveJobModal`, `SgJobRunCard`, `SgJobGroupCard`
  - Helper functions added: `timeAgo`, `analyzeSchemaSql`, `analyzeSeedSql`, `groupJobs`
  - Schema Gen state: `sgSchemaSql`, `sgSeedSql`, `sgSchemaFile`, `sgSeedFile`, `sgRunning`, `sgLog`, `sgLastStatus`, `sgShowSaveModal`, `sgJobs`, `sgExcelTables`, `sgShowExcelPreview`
  - `handleSgRun`: executes Schema + optional Seed SQL via `/api/sql-execute` using the currently connected PG DB; builds per-line log
  - `handleSgSaveJob` / `handleSgLoadJob`: POST/GET `/api/schema-generator/jobs`; loading a job restores SQL fields
  - `loadSgJobs`: GET `/api/schema-generator/jobs` on mount + after save
  - Two-column layout: left = Excel import + Schema SQL + Seed SQL + Execute + log; right = Job History grouped by job name
  - Excel import → `SgExcelPreviewModal` → applies generated schema + seed SQL into text fields
  - Fixed `Node` type collision (ReactFlow's `Node` vs DOM `Node`) by using `HTMLElement` in `SgPopover` click-outside handler
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

---
## 2026-05-20
- **implement** — Schema Explorer: flat grouped table panel, ERD node navigate, print/PNG
  - Left panel rewrite: flat list grouped by schema (no collapsible); schema header has indeterminate "check all" checkbox; `loadSchemas` auto-loads all schemas on connect
  - `toggleSchemaErd`: check/uncheck all tables in a schema at once; individual table checkboxes still work
  - `filteredSchemas` now also matches on table names within schema (not just schema name)
  - ERD `TableNode` header: `ExternalLink` icon button calls `onTableClick` via `onMouseDown` to avoid drag interference
  - ERD node click + `ExternalLink` button both navigate to Columns tab for that table
  - Tab bar Columns context: "ERD" button switches back to ERD tab; table name shown as mono label
  - Print/PNG panel in ERD canvas (top-right): paper size (A4/A3/Letter/Legal), orientation (portrait/landscape), Print opens popup window with `@page` CSS and auto-prints; PNG downloads via `html-to-image`
  - Installed: `html-to-image`
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **implement** — Schema Explorer: Records panel + ERD node → Columns navigation
  - New API `POST /api/schema-explorer/records` — fetches rows with COUNT, LIMIT/OFFSET (max 200), sanitized identifiers; supports PG + MySQL
  - Records panel renders below Foreign Keys in Columns tab — auto-loads on table select, 50 rows/page with Prev/Next pagination, Reload button
  - `null` values rendered as italic `null`; all values coerced to string for display
  - ERD node click (`onNodeClick`) → calls `selectTable(node.id)` → switches to Columns tab and loads columns + records for that table
  - Files: `src/pages/api/schema-explorer/records.ts` (new), `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: minimalist connected indicator
  - Removed "✓ Connected" text label
  - DB type badge changes to green border + small check icon when connected; reverts to blue when disconnected
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: add database picker in header
  - After picking a connection, loads database list via `/api/pg-databases` (PG) or `/api/list-databases` (MySQL)
  - Auto-selects `database_name` from the saved connection if present in list, else first in list
  - `connPayload` now uses the selected database instead of the hardcoded `database_name`
  - Connect button disabled until both connection and database are chosen
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: new navbar UI (matches Schema Generator & Export/Import)
  - Header: sticky, backdrop-blur, `bg-white/95`, icon + title + subtitle on left, breadcrumb nav (Home › Schema Explorer) on right
  - Connection controls (saved connection picker, DB type badge, Connect/Disconnect/Refresh) remain inline between title and breadcrumb
  - Removed `ArrowLeft` back-button pattern
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: replace manual connection form with saved connection picker
  - Removed: DB type toggle, host/port/database/username/password inputs, show-password button
  - Added: `<select>` grouped by PostgreSQL/MySQL listing all `dbt_connections` records (label + database_name)
  - `connToPayload()` helper maps `ConnectionRow` → `ConnPayload` (including `db_type: 'postgres'` → `'postgresql'`)
  - All API calls guard against null `connPayload` (no connection selected)
  - Cleaned unused imports: `ConnForm`, `DbType`, `FkInfo`, `Eye`, `EyeOff`, `useRef`
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done



- **fix** — Import tab: add "Create new DB" to Target database selector
  - New `/api/create-database.ts` — unified PG + MySQL create DB endpoint (auth-protected)
  - `DbSelector` in `export-import.tsx` — added `allowCreate` prop; shows Existing/New toggle; calls new API
  - Only Import tab passes `allowCreate` — Export and Sync tabs unaffected
  - Files: `src/pages/api/create-database.ts` (new), `src/pages/export-import.tsx`
  - Status: done

- **implement** — Export & Import: 8 enhancements
  - **Shared lib** — `src/lib/excel-parser.ts` extracted from db-setup; reused by both Schema Generator and Export & Import
  - **Table row counts** — `listTablesWithCounts()` in `sql-exporter.ts`; `TableSelector` shows row counts + >50k warning badge
  - **Excel import (Import tab)** — SQL/Excel toggle; drag-drop `.xlsx`/`.xls`; `ExcelImportModal` with column type editor → generates INSERT SQL
  - **Dry-run preview** — "Preview" button before import shows statement breakdown (CREATE/INSERT/DROP/TRUNCATE) + destructive warning
  - **WHERE filter (Export)** — Optional per-export filter applied to all SELECT queries; toggled via "Add WHERE filter"
  - **CSV export** — Format picker (SQL/CSV); CSV path zipped client-side via JSZip with one file per table
  - **Conflict strategy (Sync)** — `ConflictPicker`: INSERT only / TRUNCATE+INSERT / Upsert (ON CONFLICT DO NOTHING / INSERT IGNORE)
  - **Operation history** — `dbt_export_history` table; right-side `HistoryPanel` per tab; delete entries; persists across sessions
  - **Large dataset warning** — Tables >50k rows flagged amber in TableSelector
  - Files: `src/lib/excel-parser.ts` (new), `src/lib/sql-exporter.ts`, `src/pages/export-import.tsx`, `src/pages/api/export-import/tables.ts`, `src/pages/api/export-import/export.ts`, `src/pages/api/export-import/sync.ts`, `src/pages/api/export-import/history.ts` (new), `db/migrations/005_export_history.sql` (new)
  - Installed: `jszip`
  - Status: done

## 2026-05-20
- **implement** — Schema Designer: Guide modal
  - `GuideModal` component — scrollable modal dengan 7 sections: Overview, Navbar, Designer Tab, Column Properties (table), FK Relationship Picker, Import Tab, Execute Tab, Tips
  - `HelpCircle` + `BookOpen` icons dari lucide-react
  - Button `Guide` dalam tab bar (kanan, `ml-auto`) — `HelpCircle` icon + label, hover style biru; click buka modal
  - `showGuide` state dalam `SchemaDesignerInner`
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: FK/PK relationship picker + schema tree + navbar UX
  - `FkPickerModal` — visual two-panel modal (tables left, columns right); PK/UQ badges on columns; click to set FK; "Remove FK" button; replaces free-text `table.col` input
  - `ColumnEditorPanel` — FK Reference cell changed from text input to button-badge (shows `table.col` as blue badge, click to re-pick, × to clear); relationship summary section below column table showing outgoing FKs and incoming references (tables that point to this table)
  - `TableTreePanel` — hierarchical schema tree for PostgreSQL (schema → tables); per-schema hover "+ Add Table" button; FK indicator icon on tables with outgoing FKs; referenced-by indicator on tables pointed to by others; header split into two rows: title + labeled "New Schema" / "New Table" buttons (PG-only schema button)
  - `NewSchemaDialog` — new dialog for adding a schema node to designer (sanitises name to lowercase alphanumeric); schema tracked in `designerSchemas` state; `CREATE SCHEMA IF NOT EXISTS` generated at DDL time
  - `NewTableDialog` — added `defaultSchema` prop; clicking "Add Table" under a schema pre-fills schema field
  - Navbar: connection dropdown has `+ New Connection →` option (navigates to `/connections`); DB dropdown has `+ New Database…` option (opens NewDbDialog inline, replaces standalone "New DB" button); PostgreSQL badge only appears for PG connections (MySQL connection shows no badge)
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

## 2026-05-19
- **implement** — Export & Import module (`/export-import`)
  - 3 tabs: Export, Import, Sync
  - **Export**: pick connection (MySQL or PG), select database, select tables (all or custom checkbox list), include schema/data/both → SQL dump with copy + download
  - **Import**: pick target connection + database, paste or drag-drop `.sql` file → execute with rollback on failure
  - **Sync**: source connection + database → target connection + database, same DB type only; cross-type (MySQL↔PG) shows warning to use Migration module instead
  - Per-step rollback on import and sync target
  - Status: done

- **implement** — Export & Import API routes
  - `POST /api/export-import/tables` — list tables for any connection (MySQL or PG)
  - `POST /api/export-import/export` — pure-SQL dump generator (PG: `information_schema` + `pg_indexes`; MySQL: `SHOW CREATE TABLE` + `SELECT *`)
  - `POST /api/export-import/import` — execute SQL on target with `BEGIN/COMMIT/ROLLBACK` (PG) or `beginTransaction/commit/rollback` (MySQL)
  - `POST /api/export-import/sync` — export from source then import into target in one call
  - Status: done

- **implement** — `src/lib/sql-exporter.ts` — shared export engine
  - `listTables(cfg)` — unified table listing for both DB types
  - `exportDatabase(cfg, tables, include)` — generates header + per-table DDL + INSERT blocks
  - PG value escaping: NULL, boolean, number, Date, Buffer, object (JSON), string
  - MySQL value escaping: NULL, boolean, number, Date, Buffer, object (JSON), string with backslash handling
  - Status: done

- **implement** — Home screen: Export & Import link activated
  - `href: '/export-import'`, `available: true`
  - Status: done

- **implement** — Schema Generator: Excel import (`/db-setup`)
  - New `ExcelImportCard` — drag-drop / browse `.xlsx`/`.xls`, shown between Step 2 and Step 3
  - New `ExcelPreviewModal` — sheet list sidebar, per-column type editor (10 PG types), nullable toggle, sample data toggle
  - Helper functions: `parseExcelFile` (SheetJS dynamic import), `inferPgType`, `sanitizePgName`, `generateSchemaSqlFromTables`, `generateSeedSqlFromTables`
  - On apply: auto-populates Schema SQL (Step 3) + Seed SQL (Step 4), clears any previous file badges
  - Installed: `xlsx` (SheetJS)
  - Files: `src/pages/db-setup.tsx`, `package.json`
  - Status: done

- **implement** — DEVLOG.md created; CLAUDE.md instruction added
  - All past implementation history recorded by date
  - Status: done
