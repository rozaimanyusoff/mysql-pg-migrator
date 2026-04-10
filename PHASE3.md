# Phase 3: Documentation Generation & Dry Run

## Overview

Phase 3 provides the ability to:
1. **Generate Documentation** - Create comprehensive guides in multiple formats
2. **Perform Dry Run** - Validate configuration and preview SQL
3. **Review Before Migration** - Ensure everything is correct before executing

## Accessing Phase 3

From Phase 2:
1. Click **"Proceed to Phase 3"** button in footer
2. Or navigate directly to `/docs`
3. Configuration is loaded from localStorage (saved in Phase 2)

## Features

### 1. Documentation Generation

Three documentation formats available:

#### Markdown Document (.md)
**Best for:** Team discussions, version control, comprehensive reference

Contains:
- Executive summary
- Table mapping summary
- Detailed column mappings
- Data type conversions
- Index strategy
- Migration steps
- Pre-migration checklist
- Rollback plan

**Use Case:** Share with team for review and approval

```markdown
# MySQL → PostgreSQL Migration Document

**Generated:** 2024-01-15
**Status:** Ready for Review

## Table Mapping Summary

| MySQL Table | PostgreSQL Table | Schema | Status |
|-------------|------------------|--------|--------|
| users | users | public | ✓ Ready |
| posts | posts | content | ✓ Ready |
```

#### Spreadsheet (CSV)
**Best for:** Collaborative review, editing, tracking changes

Multiple sheets:
- **Summary:** Migration metadata and statistics
- **Mappings:** Detailed table and column mappings
- **Checklist:** Pre/during/post-migration tasks

**Use Case:** Open in Excel/Sheets, collaborate with team, make notes

```csv
MySQL Table,PostgreSQL Schema,PostgreSQL Table,Description,Include
users,public,users,User accounts,Yes
posts,content,posts,Blog posts,Yes
```

#### SQL Script (.sql)
**Best for:** Database administrators, understanding exact DDL

Contains:
- Schema creation statements
- Table creation DDL
- Index creation statements
- Comments for each section

**Use Case:** Review SQL before execution, run in database tool

```sql
-- Create Schemas
CREATE SCHEMA IF NOT EXISTS "content";

-- Create Tables
CREATE TABLE IF NOT EXISTS "public"."users" (
  "user_id" INTEGER PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" VARCHAR NOT NULL
);
```

### 2. Dry Run Validation

**What it does:**
- Validates configuration for consistency
- Checks for duplicate table/column names
- Verifies primary key definitions
- Generates all SQL statements
- Shows estimated migration size

**What it checks:**
✓ At least one table selected for migration  
✓ No duplicate table names in same schema  
✓ No duplicate column names in same table  
✓ All required primary keys defined  

**Output:**
```
Migration Summary
├─ Tables: 5
├─ Columns: 42
├─ Indexes: 8
├─ Schemas: 3 (public, content, audit)
└─ SQL Statements: 16
```

### 3. SQL Preview

Shows exact SQL that will be executed:
- Schema creation
- Table creation with all columns
- Index creation
- Constraint definitions

Allows you to:
- Review before running
- Copy for manual execution
- Modify if needed

---

## Workflow

### Step 1: Load Configuration

When you open Phase 3:
1. Configuration loads from localStorage
2. Shows summary of what will be migrated
3. Displays any unsaved changes warning

### Step 2: Generate Documentation

Choose format based on needs:

**For Team Review:** Generate Markdown + CSV
- Share both documents in meeting
- Team reviews and suggests changes
- Collect feedback

**For Database Admin:** Generate SQL
- DBA reviews SQL statements
- Checks for any issues
- Prepares execution plan

### Step 3: Perform Dry Run

Before any actual migration:
1. Click **"Run Dry Run"**
2. System validates configuration
3. Shows any errors or warnings
4. Previews all SQL statements
5. Estimates scope

### Step 4: Review Results

If validation passes:
- ✓ Configuration is valid
- ✓ SQL looks correct
- ✓ Ready to proceed

If validation fails:
- ✗ Errors prevent migration
- Go back to Phase 2 to fix
- Re-run dry run

---

## Documentation Examples

### Markdown Output Sample

```markdown
# MySQL → PostgreSQL Migration Document
**Generated:** 2024-01-15
**Migration Name:** mydb_migration
**Status:** draft

## Executive Summary

This document details the migration of **5** tables from MySQL `mydb` to PostgreSQL.

- **Tables to migrate:** 5
- **PostgreSQL schemas:** 3 (public + custom)
- **Target database:** mydb_pg

## Table Mapping Summary

| MySQL Table | PostgreSQL Schema | PostgreSQL Table | Status |
|-------------|-------------------|------------------|--------|
| `users` | `public` | `users` | ✓ Ready |
| `posts` | `content` | `posts` | ✓ Ready |

## Detailed Table Mappings

### public.users

**Purpose:** User accounts with authentication credentials

| MySQL Column | Type | PostgreSQL Column | Type | Index | Notes |
|------------|------|-----------------|------|-------|-------|
| `user_id` | INT | `user_id` | INTEGER | UUID | PRIMARY KEY |
| `email` | VARCHAR(255) | `email` | VARCHAR | None | UNIQUE |
| `created_at` | DATETIME | `created_at` | TIMESTAMP | None | |

## Pre-Migration Checklist

- [ ] Backup MySQL database
- [ ] Backup PostgreSQL database (if existing)
- [ ] Test migration on staging environment
- [ ] Verify all data type conversions
- [ ] Check foreign key relationships
- [ ] Validate row counts post-migration
- [ ] Test application with new schema
- [ ] Plan downtime window
```

### CSV Output Sample

```
MIGRATION SUMMARY
Migration Name,mydb_migration
Source Database,mydb
Target Database,mydb
Status,draft
Generated,2024-01-15T10:30:00Z

STATISTICS
Total Tables,5
Tables to Migrate,5
Tables Excluded,0
PostgreSQL Schemas,3

TABLE AND COLUMN MAPPINGS
MySQL Table,PostgreSQL Schema,PostgreSQL Table,MySQL Column,PostgreSQL Column,PostgreSQL Type
users,public,users,user_id,user_id,INTEGER
users,public,users,email,email,VARCHAR
posts,content,posts,post_id,post_id,INTEGER
```

### SQL Output Sample

```sql
-- MySQL to PostgreSQL Migration Script
-- Generated: 2024-01-15T10:30:00Z
-- Migration: mydb_migration

-- THIS IS A DRY RUN PREVIEW
-- Review carefully before executing

-- 1. Create Schemas
-- =================
CREATE SCHEMA IF NOT EXISTS "content";
CREATE SCHEMA IF NOT EXISTS "audit";

-- 2. Create Tables
-- =================
-- Schema: public, Table: users
CREATE TABLE IF NOT EXISTS "public"."users" (
    "user_id" INTEGER PRIMARY KEY DEFAULT gen_random_uuid(),
    "email" VARCHAR NOT NULL,
    "created_at" TIMESTAMP WITHOUT TIME ZONE
);

-- Schema: content, Table: posts
CREATE TABLE IF NOT EXISTS "content"."posts" (
    "post_id" INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "user_id" INTEGER NOT NULL,
    "title" VARCHAR NOT NULL,
    "content" TEXT
);

-- 3. Create Indexes
-- =================
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email" ON "public"."users" ("email");
```

---

## Dry Run Results

### Validation Passed ✓

```
✓ Migration configuration is valid

Migration Summary
  Tables: 5
  Columns: 42
  Indexes: 8
  Schemas: 3
  SQL Statements: 16

Ready to proceed with migration!
```

### Validation Failed ✗

```
✗ Validation failed

Errors:
  • No tables selected for migration
  • Duplicate table name: "public"."users"
  • Table "posts" has no primary key

Fix these issues and try again.
```

---

## Common Scenarios

### Scenario: Single Database Migration

1. **Generate Markdown** → Share with team
2. **Team reviews** → Suggests edits
3. **Return to Phase 2** → Make changes
4. **Re-run dry run** → Validate again
5. **Approve** → Ready for migration

### Scenario: Multiple Stakeholders

1. **Generate CSV** → Open in Excel
2. **Share with team** → Collect feedback in spreadsheet
3. **Track changes** → Version control in Git
4. **Generate SQL** → DBA reviews
5. **Finalize** → Everyone approves

### Scenario: Complex Schema

1. **Generate Markdown** → Technical reference
2. **Generate SQL** → Review DDL details
3. **Dry run** → Validate all columns and types
4. **Check summary** → Verify statistics
5. **Proceed** → All details confirmed

---

## Tips & Best Practices

### Documentation Review

✓ **Always generate docs before migration**
✓ **Share with full team** - Database admins, developers, QA
✓ **Document approval** - Get sign-off before executing
✓ **Keep version history** - Track all documents in Git

### Dry Run Validation

✓ **Review all warnings** - May indicate issues
✓ **Check SQL carefully** - Look for any unexpected changes
✓ **Verify statistics** - Row counts, column counts match expectations
✓ **Test on staging** - Run actual migration on test environment first

### Before Actual Migration

✓ **Backup both databases** - MySQL source and PostgreSQL target
✓ **Have rollback plan** - Know how to restore if issues occur
✓ **Schedule downtime** - Notify users about migration window
✓ **Test application** - Verify app works with new schema
✓ **Monitor logs** - Watch for errors during migration

---

## Troubleshooting

### "No migration configuration found"

**Cause:** localStorage was cleared or using different browser

**Solution:**
1. Go back to Phase 2
2. Save configuration again
3. Return to Phase 3

### "Configuration is invalid"

**Cause:** Schema has issues

**Solutions:**
- Review errors shown
- Go back to Phase 2
- Fix the issues
- Re-run dry run

### Documentation download doesn't work

**Cause:** Browser popup blocker

**Solution:**
- Allow popups for this site
- Or use Copy button instead
- Paste into text editor and save

### SQL looks wrong

**Cause:** Data type conversion or mapping issue

**Solution:**
1. Review generated SQL carefully
2. Go back to Phase 2
3. Fix the column mapping
4. Re-run dry run

---

## Next Steps (Phase 4)

Phase 4 (Future) will add:
- [ ] Connect to PostgreSQL database
- [ ] Execute migration automatically
- [ ] Monitor progress
- [ ] Verify results
- [ ] Rollback if needed

For now, use generated SQL script in Phase 3 to run migration manually:

```bash
# Option 1: Use psql command line
psql -h localhost -U postgres < migration.sql

# Option 2: Copy/paste into pgAdmin
# SQL Editor → Paste SQL → Execute

# Option 3: Use database tool
# Connect to PostgreSQL
# Open SQL editor
# Paste SQL from Phase 3
# Execute
```

---

## Document Retention

**Recommended:** Keep all generated documents

**Where:** Version control (Git) or shared drive

**Structure:**
```
migrations/
├── 2024-01-15_mydb_v1/
│   ├── migration_config.json
│   ├── mapping_document.md
│   ├── mapping_spreadsheet.csv
│   └── migration_script.sql
├── 2024-02-01_mydb_v2/
│   ├── migration_config.json
│   ├── mapping_document.md
│   ├── mapping_spreadsheet.csv
│   └── migration_script.sql
```

---

## FAQ

**Q: Can I edit the generated documentation?**  
A: Yes! Edit markdown and CSV files before sharing. SQL should not be edited unless you know what you're doing.

**Q: What if dry run shows warnings?**  
A: Warnings don't prevent migration but may indicate issues. Review and decide if they need fixing.

**Q: Can I go back to Phase 2 from Phase 3?**  
A: Yes! Click the back button. Changes save to localStorage automatically.

**Q: How long does dry run take?**  
A: Usually instant for schemas up to 100 tables. Larger schemas may take a few seconds.

**Q: Can I run migration from Phase 3?**  
A: Not yet - Phase 4 will add automatic execution. For now, use the SQL script manually.

**Q: Where's my configuration saved?**  
A: In browser localStorage. Won't sync across browsers. Download JSON in Phase 2 for backup.

---

**Status:** ✅ Phase 3 Complete - Ready for Phase 4 (Migration Execution)

