# ApexFit

A React + Vite application foundation for ApexFit coaching workspaces.

## Run locally

```powershell
npm install
npm run dev
npm test
npm run build
```

## Configuration

Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the Supabase project URL and publishable/anon key. These browser variables must never contain a service-role key.

In Supabase:

1. Enable Google under **Authentication → Providers** and configure the Google OAuth client credentials.
2. Add the local and production app URLs to the Supabase redirect URL allow-list and Google OAuth authorized redirect URIs.
3. Apply the migrations in `supabase/migrations/` using the Supabase CLI (`supabase db push`) or the SQL editor, in filename order. For a one-time SQL Editor setup, copy and run `supabase/manual-setup.sql`.

Google sign-in records whether the user is entering as a coach or client before redirecting. On the first authenticated return, `provision_my_profile` creates the account profile. New coach accounts receive a database-generated 72-hour trial; the role and trial dates cannot be edited by the browser. `get_my_access_status` calculates access using database time and an active subscription record, and the app refreshes status on focus and at trial expiration.

The exercise catalog is not seeded with fabricated entries. The prepared `data/free-exercise-db-apexfit.json` is transformed from the public-domain [free-exercise-db](https://github.com/yuhonas/free-exercise-db) dataset (876 records at the pinned upstream revision); its source has exercise instructions and image thumbnails, but no demo videos. Categories are `strength`, `cardio`, `mobility`, `plyometrics`, or `warmup`; difficulty is `beginner`, `intermediate`, or `advanced`. Equipment and muscle tags use lowercase snake case and the supported localized filters. Regenerate the file with `npm run prepare:exercise-catalog`; import it locally after applying the migrations:

```powershell
$env:SUPABASE_URL = "https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "your-service-role-key"
npm run import:exercises -- .\data\free-exercise-db-apexfit.json
```

The source contains 876 records, not 1,000; a second verified source is required to meet the earlier 1,000-exercise target. The importer validates every record, upserts by slug, and publishes the imported rows. Keep the service-role key only in the local environment or a trusted server; never put it in a `VITE_` variable, source file, or browser. The exercise library uses exact-count, server-side pagination and search/filters. Demo videos are only embedded from HTTPS YouTube/Vimeo URLs or played as HTTPS MP4/WebM files.

Coach-owned program tables enforce owner, coach role, and active-trial/subscription access with RLS; program saves use a transactional RPC. UI route checks are not a security boundary. Subscription rows are read-only to authenticated users and should only be written by a trusted billing webhook/service role. Configure a payment provider and webhook before enabling paid checkout; the $39/month plan is displayed, but checkout is intentionally not simulated.

## Project structure

- `src/components/` — app shell, language selector, brand, and reusable UI
- `src/contexts/` and `src/i18n/` — persisted English, Arabic, German, French, and Spanish preferences with automatic RTL for Arabic
- `src/pages/` — landing, coach workspace, manual workout builder, exercise library, client portal, settings, and subscription/trial screens
- `src/services/` — Supabase client, Google OAuth/account provisioning, exercise search, program persistence, client workout/progress/habit data, trial helpers, and AI backend boundary
- `supabase/migrations/` — PostgreSQL accounts, trials, exercise/program tables, client tracking tables, storage bucket, and RLS
- `supabase/manual-setup.sql` — combined SQL for the Supabase SQL Editor
- `data/` — prepared exercise JSON and its source/license notes
- `scripts/import-exercise-catalog.mjs` — local, service-role-only import for a verified exercise catalog JSON file
- `scripts/prepare-free-exercise-db.mjs` — downloads the pinned public-domain source and prepares the normalized catalog
- `public/apexfit-logo.png` — supplied ApexFit logo used throughout the app

Client workout logs, body measurements/photos, and habit logs are private to each authenticated client. Client roster, billing, and message screens use empty states until their real APIs are connected. The exercise catalog remains empty in Supabase until the prepared data is imported; no sample records or fabricated business metrics are included.

## Priority 2 features

- **Program templates:** coaches mark programs as templates (is_template) and use them to create an editable copy through the duplicate_training_program RPC. Only the owning, active coach can copy or flag a program.
- **Onboarding form:** a client completes one private client_intake_forms record (goal, experience, schedule, equipment, height, injuries, health, diet). Coach-side viewing and coach-defined custom questions need a coach-client relationship (invites/roster), which is not built yet.
- **1RM tracking:** get_my_one_rep_max_history() derives the best Epley estimate per exercise and day from the client's logged weighted sets of 1-12 reps. No separate data entry is required.
- **Food logger:** clients log meals, calories, optional macros, and ingredients in client_food_logs; there is no bundled food database, so values are entered manually.

Apply supabase/migrations/20261115000400_priority2_templates_intake_strength_food.sql (or re-run supabase/manual-setup.sql, which is idempotent) after the earlier migrations. The migration also relaxes the client date checks to allow the client's local date to be one day ahead of UTC.
