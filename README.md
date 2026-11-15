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
3. Apply `supabase/migrations/20261115000100_core_accounts.sql` using the Supabase CLI (`supabase db push`) or the SQL editor.

Google sign-in records whether the user is entering as a coach or client before redirecting. On the first authenticated return, `provision_my_profile` creates the account profile. New coach accounts receive a database-generated 72-hour trial; the role and trial dates cannot be edited by the browser. `get_my_access_status` calculates access using database time and an active subscription record, and the app refreshes status on focus and at trial expiration.

When adding coach-owned data tables, enforce coach access in database RLS policies using `get_my_access_status()`; UI route checks are not a security boundary. For example, combine the row owner check with `public.get_my_access_status()->>'access_state' in ('trialing', 'active')` in both `USING` and `WITH CHECK` policies. Subscription rows are read-only to authenticated users and should only be written by a trusted billing webhook/service role. Configure a payment provider and webhook before enabling paid checkout; the $39/month plan is displayed, but checkout is intentionally not simulated.

## Project structure

- `src/components/` — app shell, language selector, brand, and reusable UI
- `src/contexts/` and `src/i18n/` — persisted English, Arabic, German, French, and Spanish preferences with automatic RTL for Arabic
- `src/pages/` — landing, coach workspace, client portal, settings, and subscription/trial screens
- `src/services/` — Supabase client, Google OAuth/account provisioning, trial helpers, and AI backend boundary
- `supabase/migrations/` — PostgreSQL account, role, locale, and trial schema with RLS and access functions
- `public/apexfit-logo.png` — supplied ApexFit logo used throughout the app

Client roster, workout, billing, and message screens use empty states until real APIs and data tables are connected; no sample client records or fabricated business metrics are included.
