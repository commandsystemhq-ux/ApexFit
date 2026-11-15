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

## Coaching business features

Migration `20261115000500_coaching_business.sql` (also in `supabase/manual-setup.sql`) adds the coach-client link and everything that depends on it. Server-side work lives in `api/` as Vercel Functions; the browser never sees a secret.

- **Coach-client link:** a coach creates a single-use invite code (valid 7 days) and the client enters it under *My coach -> Coach*. Coaches then see their roster and each client's onboarding answers. Row-level security scopes all data to the linked pair.
- **Messaging:** coaches send notes and videos (MP4/WebM/MOV, 50 MB) to one, some, or all active clients (`send_coach_message`). Videos live in the private `apexfit-coach-videos` bucket and are served to recipients through short-lived signed URLs. Messages are one-way; clients cannot reply yet.
- **Packages and invoices:** coaches define packages (for example 10 sessions) and issue invoices; clients can also buy an active package. Amounts and currency come from the database, never the browser. Stripe Checkout uses destination charges to the coach's Stripe Connect Express account; `STRIPE_PLATFORM_FEE_PERCENT` optionally keeps a platform fee. The webhook (`/api/stripe-webhook`) verifies Stripe's signature and calls the service-role-only `mark_invoice_paid`, which is idempotent, checks the amount, and grants session credits.
- **Sessions:** coaches schedule sessions; completing one consumes a credit from the client's oldest paid package, and reopening or canceling it restores the credit.
- **Google Calendar:** one-way sync from ApexFit to the coach's primary calendar through OAuth with offline access. The refresh token is AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` and is never readable from the browser. Events use a deterministic ID, so re-syncing updates instead of duplicating.
- **Push notifications:** Web Push (VAPID) through `public/sw.js`. Clients opt in under *My coach -> Coach*. Delivery is best effort and runs when a coach sends a message, schedules or cancels a session, or issues an invoice. On iPhone, ApexFit must first be added to the Home Screen.

### Environment and third-party setup

Set the server variables from `.env.example` in Vercel. Then:

1. **Supabase:** run `supabase/manual-setup.sql`. Copy the service-role key into `SUPABASE_SERVICE_ROLE_KEY` (server only).
2. **Secrets:** `TOKEN_ENCRYPTION_KEY` = `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. VAPID keys = `npx web-push generate-vapid-keys`.
3. **Stripe:** enable Connect (Express) on your platform account, set `STRIPE_SECRET_KEY`, and add a webhook to `https://<app>/api/stripe-webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `account.updated` (with Connect events enabled). Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. **Google:** create an OAuth web client, enable the Google Calendar API, add the redirect URI `https://<app>/api/google?action=callback`, and set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. The `calendar.events` scope needs Google's OAuth verification before use outside test users.
5. **APP_URL** must be the public origin, for example `https://apexfit.vercel.app`.

`npm run dev` serves only the front end; use `vercel dev` to exercise the `/api` functions locally. The $39 coach subscription checkout is still not implemented.

## Community and gamification

Migration `20261115000600_community_gamification.sql` (included in `supabase/manual-setup.sql`) adds a community per coach: the coach and that coach's active clients.

- **Privacy:** posts, comments, and reactions have no direct table access; everything goes through security definer functions that check community membership. Members pick a display name, and only that name is shown to others. Workouts, meals, and photos are never exposed. Clients can hide themselves from the leaderboard.
- **Feed:** updates, coach announcements, and achievement posts with reactions (like, fire, clap), comments, paging, and optimistic reaction updates. Authors and the community's coach can delete content. There is no automated moderation, image upload, or report flow yet.
- **Points:** database triggers award points for workouts (50), meals (5), daily habits (10), and body measurements (10). Points apply only to entries dated today or yesterday and each activity has a daily cap (2 workouts, 4 meals, 1 habit log, 1 measurement), which limits back-filling and spam. Clients cannot write points directly.
- **Levels, streaks, badges:** 250 points per level; a streak counts consecutive days with any points. Badges are computed from real data, and a badge can be shared to the feed only after it is earned (verified by the database).
- **Leaderboard:** ranks opted-in clients by points over 7 days, 30 days, or all time within one coach's community.
