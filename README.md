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

## Routing, auth pages, and profile settings

The app uses path routing (`react-router-dom`). `src/routes.js` is the single source for paths, navigation, and role access:

- Public: `/` (landing), `/login`, `/signup`. Signed-in users are redirected away from these to their workspace.
- Coach: `/dashboard`, `/generator`, `/workout-builder`, `/templates`, `/exercises`, `/messages`, `/clients`, `/schedule`, `/invoicing`, `/billing`.
- Client: `/workouts`, `/progress`, `/strength`, `/food`, `/habits`, `/intake`, `/coach-hub`.
- Shared: `/community`, `/leaderboard`, `/settings`.

Unauthenticated visits to any protected path redirect to `/login` and return to the requested page after login. Coaches opening client pages (and clients opening coach pages) are redirected to their own home; a coach whose trial has ended can only open billing and settings. Old `/#coachHub`-style links are redirected. Static hosting must serve `index.html` for unknown paths; `vercel.json` does this for Vercel, and Vite's dev/preview servers do it by default.

`/login` and `/signup` support email + password and Google. In Supabase, enable **Authentication → Providers → Email** (turn on "Confirm email" if you want confirmation) and add `<app-url>/login` and `<app-url>` to the redirect allow-list. The chosen role is stored in the sign-up metadata, so `provision_my_profile` can create the profile even after confirming in another browser. Google login for an email with no profile asks the user to sign up first.

Settings includes a profile section (all roles: photo, name, email; coaches also get a brand name). Migration `20261115000700_profile_settings_avatars.sql` (also in `supabase/manual-setup.sql`) adds `full_name`, `brand_name`, and `avatar_path` to `profiles`, the `update_my_profile` RPC, and a public `avatars` bucket (JPG/PNG/WebP, 2 MB) where each user can only write to their own `<user-id>/` folder. Saving a coach's name or brand also updates the coach name shown on their client links and invites. Changing the email sends a Supabase confirmation message and takes effect once confirmed.

## Project structure

- `src/components/` — app shell, language selector, brand, and reusable UI
- `src/contexts/` and `src/i18n/` — persisted English, Arabic, German, French, and Spanish preferences with automatic RTL for Arabic
- `src/routes.js` — route table, navigation, and role access
- `src/pages/` — landing, login/signup, coach workspace, manual workout builder, exercise library, client portal, settings, and subscription/trial screens
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
## Automated workflows

Migration `20261115000800_automated_workflows.sql` (included in `supabase/manual-setup.sql`) adds onboarding and follow-up sequences at `/workflows` (coach only).

- **Tables:** `workflows` (trigger and on/off switch), `workflow_steps` (day delay, `send_message` or `assign_task`, message template), and `workflow_logs`, one row per step, client, and triggering event. A unique key on that row is what stops the same step being sent twice. RLS lets each coach read only their own rows; every write goes through `save_workflow`, `set_workflow_active`, and `delete_workflow`.
- **Triggers:** `client_joined` fires when a client redeems an invite, and `plan_assigned` fires from `assign_program_to_client` (use **Assign to client** on a program card in Program templates). `workout_missed` (no workout for two days, once per absence) and `milestone_reached` (new level or badge) are detected by the scheduled engine pass. Existing milestones are skipped when a workflow is created, so clients are not congratulated retroactively.
- **Delivery:** day 0 steps are sent immediately; later steps are sent when they become due. Messages and tasks arrive as coach notes in the client's Coach Hub (tasks are prefixed with a localized "Task:"). Templates support `{client_name}`, `{coach_name}` and `{brand_name}`. Steps are skipped for paused workflows, archived clients, and coaches whose trial or plan has lapsed.
- **Scheduling:** opening the Workflows page (or pressing **Run now**) processes that coach's due steps. For unattended runs, either enable `pg_cron` before applying the migration (it schedules `run_workflow_engine()` hourly), or set `CRON_SECRET` in Vercel; `vercel.json` then calls `/api/workflows` daily.
- **Not included:** push notifications for automated messages, and retroactive enrollment of existing clients.
- **Tests:** `tests/workflowEngine.test.js` applies the real migration to an in-process Postgres (`@electric-sql/pglite`) and checks scheduling, variable substitution, de-duplication, trigger behavior, and RLS.
## Jack, the AI assistant

Jack is a floating assistant (bottom corner, every signed-in page) that opens a chat drawer. It answers questions about ApexFit and can perform actions for the signed-in user. Chat history is kept per browser tab in `sessionStorage`.

- **Setup:** set `OPENAI_API_KEY` or `GEMINI_API_KEY` on the server (OpenAI wins when both exist; override with `JACK_PROVIDER` and `JACK_MODEL`, defaults `gpt-4o-mini` and `gemini-2.0-flash`). Without a key, Jack answers "not set up yet". Apply migration `20261115000900_jack_assistant.sql` (included in `manual-setup.sql`).
- **Security:** `/api/jack` verifies the Supabase JWT and reads the role from `get_my_access_status`; the role, user id, and route the browser sends are not trusted. The model is only offered the verified role's tools, each tool re-checks the role, and every database call runs with the user's own JWT, so RLS and the role checks inside the SQL functions still apply. Only plain user/assistant text is accepted from the browser (no system or tool messages), history and message length are capped, and requests are rate limited to 20 per minute per user (per server instance).
- **Coach tools:** `create_workflow`, `assign_program_to_client` (client by name or email, program by title), `create_community_post`, `get_coach_summary` (counts and names only, no emails or workout contents), `navigate_to`.
- **Client tools:** `log_workout_completion` (done only, or with exercises, sets, and weights), `log_body_metrics`, `get_my_schedule`, `navigate_to`.
- **Streaming:** the endpoint streams newline-delimited JSON events (`step`, `navigate`, `text`, `error`, `done`) so the drawer can show progress such as "Creating your automation workflow…". After a write action the current page reloads its data.
- **Privacy:** the conversation, the tool results (for example client first names in the summary), and a short account snapshot are sent to the AI provider you configure.
- **Tests:** `tests/jackTools.test.js` runs the tools against the real schema in an in-process Postgres with row-level security enforced; `tests/jackAgent.test.js` covers request sanitizing, the agent loop, and the OpenAI and Gemini adapters against mocked HTTP.
## Health assessments, e-signatures, and group coaching

Migration `20261115001000_assessments_contracts_groups.sql` (included in `supabase/manual-setup.sql`). All tables are read through row-level security and written only through security definer functions that check the caller's role and ownership.

- **Health assessment (PAR-Q)** at `/assessments` (clients). The seven standard yes/no questions plus fitness goals and past injuries are stored in `client_assessments` (one current record per client and coach; submitting again replaces it). `medical_clearance_required` is computed by the database (any "yes"), never taken from the browser. The client sees a "talk to your doctor" alert, the coach sees a "Medical clearance needed" badge and the full summary in the expanded client row on **Clients**. The questionnaire is a screening aid, not medical advice.
- **Contracts and e-signatures.** Coaches manage contracts at `/contracts` (two starter templates: liability waiver and coaching agreement; optional "required during onboarding"). Clients read and sign at `/my-contracts` by typing their name and drawing on a canvas pad. A signature stores the drawn PNG, the signer name, the signed wording (title and text snapshot), the time, and the request IP and user agent when the API exposes them. A client can sign a contract once (unique constraint). Once signed, the wording is locked: archive the contract and create a new version. Signed contracts cannot be deleted. Clients with pending required contracts, or without an assessment, see reminders at the top of every page. This is a simple electronic signature; whether it is legally sufficient depends on your jurisdiction, so have a lawyer review the templates.
- **Group coaching** at `/groups` (coach) and `/my-groups` (client). A coach creates groups (up to 25, 100 members each), adds or removes active clients, posts updates only members can read, and assigns one program to the whole group with one click. That also records an assignment per active member and starts any active "program assigned" workflow. Clients who join later receive the group's program automatically. Members never see each other's names, only the member count.
- **Jack tools.** Coach: `create_group` (members and program by name), `assign_program_to_group`, `get_client_assessment` (overview of who needs clearance, or one client's details), `create_contract`. Client: `get_my_groups`, `get_my_contracts`; Jack sends clients to the page to fill the assessment or sign, it cannot do either for them. Assessment answers, goals and injury notes read through Jack are sent to your AI provider, like other tool results.
- **Tests.** `tests/assessmentsContractsGroups.test.js` and `tests/jackEngagementTools.test.js` run against the real schema in an in-process Postgres with RLS enforced; `tests/engagementUtils.test.js` covers validation, onboarding reminders, navigation, and translations.
## Program store, trainer teams, and video sessions

Migration `20261115001100_store_team_video.sql` (included in `supabase/manual-setup.sql`). Reads go through row-level security; writes go through security definer functions that check the caller's role and ownership.

- **Store** (`/store`, clients at `/my-store`, public window at `/shop/<coach id>`). A product wraps one of the coach's programs with a price (0 = free) and currency. Clients of that coach see published products; the public page lists them without sign-in but only the coach's clients can buy. A client can have only one open or paid order per product (partial unique index), so retries and double clicks reuse the same order. Free products are delivered instantly by the database. Paid products go through `/api/store` and Stripe Checkout (the coach's Stripe Connect account from **Packages & invoices**); the existing webhook completes the order with `complete_store_order`, which only the service role can call, re-checks amount and currency, assigns the program (starting any "program assigned" workflow) and is safe to repeat. `STORE_DEMO_MODE=true` confirms paid orders without payment for testing; those sales are labelled "Test purchase". If a paid order cannot deliver the program (for example the client was archived meanwhile) the order stays paid with a note. Refund handling is not built.
- **Trainer teams** (`/team` for the head coach, `/team-clients` for assistants). The head coach invites an email and chooses permissions: assign programs, view health assessments, follow and send messages, manage groups. The invitee signs in with a **coach** account using that email and accepts; accounts that already run their own practice (clients or a paid plan) cannot join. An active member works under the head coach's plan (`access_state: trainer`), so an invitation never unlocks the coach features for free, and their access ends if the head coach's plan lapses. Each client has at most one assistant. The assistant sees only assigned clients and only what the permissions allow (RLS policies plus team-aware `assign_program_to_client`, group functions and `send_team_message`); the head coach keeps full access, sees a **Trainer** badge and a trainer filter on **Clients**, and assigns clients on **Team**. Assistants who are disabled, removed or who leave lose access at once.
- **ApexFit Live room (default, native WebRTC).** New sessions use the built-in room: no link, no external account and no third-party video service. Migration `20261115001200_live_video_room.sql` adds the `apexfit_live` provider (`meeting_url` optional) and gives every session a room name `apexfit-session-<session id>`. The coach and the invited client or group members open `/sessions/:id/room`: a full-screen page with the ApexFit bar (logo, session title, **End call**) around a peer-to-peer call. The browser asks for camera and microphone (`getUserMedia`), joins the private Supabase Realtime Broadcast channel `video-room-<session id>`, and exchanges `join`/`hello`/`offer`/`answer`/`ice-candidate` messages there; audio and video then flow directly between browsers (Google STUN `stun:stun.l.google.com:19302`). The other person fills the screen with you in a corner window, with names and roles, mute, camera on/off, screen sharing (`getDisplayMedia`) and **End call**, plus a status chip (waiting, connecting, connected) and a Retry button when camera or microphone access is refused. Up to 6 people can be in one room (full mesh). A browser without a camera joins with audio only. The code is in `src/services/webrtcRoom.js` (framework-free, tested with fakes), `src/services/roomSignaling.js` and `src/hooks/useVideoRoom.js`.
  - **Access control.** Migration `20261115001300_video_room_signaling.sql` adds `can_join_video_room(topic)` and row-level security policies on `realtime.messages`, so only the coach and the invited client (or group members) can listen or send on a room's channel, clients only from 10 minutes before the start, and nobody after the room closes. Messages are also validated in the browser (sender, recipient, size, type) before they reach a peer connection. Names and roles shown in the room are announced by the participants themselves.
  - **Limits.** Only STUN is used, which connects most home and office networks but can fail behind strict firewalls or some mobile carriers; for those, set a TURN relay with `VITE_TURN_URLS`, `VITE_TURN_USERNAME` and `VITE_TURN_CREDENTIAL`. Camera access needs HTTPS (or localhost). Screen sharing is not available on most phone browsers. A call is a mesh, so quality drops with more than 3 or 4 people.
- **Video sessions** (`/sessions`, clients at `/my-sessions`). One-to-one or group sessions with a Zoom, Google Meet or custom https link (Zoom/Meet links must be on the provider's domain). Set `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` (a Zoom Server-to-Server OAuth app with the `meeting:write:meeting:admin` scope) and an empty Zoom link is generated automatically through `/api/video-sessions`; otherwise the coach pastes a link. The meeting belongs to the Zoom account of that app, and is deleted again if saving the session fails. Clients get a push notification (when push is configured) and see a live countdown with a **Join session now** button; individual sessions are visible only to that client and group sessions only to group members.
- **Jack.** Coach tools: `create_store_product`, `get_store_sales`, `schedule_video_session` (times are read in the user's own UTC offset), `invite_trainer`. Client tools: `get_my_sessions`, `get_my_store`. Assistant trainers get navigation only.
- **Tests.** `tests/storeTeamVideo.test.js` and `tests/jackGrowthTools.test.js` run against the real schema in an in-process Postgres with RLS enforced; `tests/growthUtils.test.js` covers validation, countdowns, the Zoom client and the scheduling flow with mocked HTTP, checkout parameters, navigation and translations.


## Smart devices and nutrition

- **Integrations** (`/integrations`, clients). Two tabs. **Wearables:** import an Apple Health export (`export.xml`, the `export.zip` the Health app makes, or a CSV/JSON daily summary) - the file is read in the browser, never uploaded, and only the daily numbers (steps, active calories, sleep, resting heart rate, HRV) are saved. Connect **Fitbit**, **Oura** or **Garmin** with OAuth, press **Sync now**, or type a day by hand; the last seven days show as cards and small charts. **MyFitnessPal & Nutrition:** import the *Nutrition Summary* CSV from MyFitnessPal (meal rows are added up per day, a `Total` row is used when present, DMY/MDY dates and bad rows are detected and reported), log calories, protein, carbs, fats and water by hand, set a daily goal and follow the progress bars. The same nutrition section is on the Food page.
- **Coach view.** Open a client on the Clients page to see their device summary and the 7-day calorie/macro average, adherence against the goal, and set the client's daily goal. Assistant trainers see it only for their own clients and only with the *view assessments* permission.
- **Optional environment variables** (see `.env.example`): `FITBIT_CLIENT_ID` / `FITBIT_CLIENT_SECRET`, `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`, `GARMIN_CLIENT_KEY` / `GARMIN_CLIENT_SECRET`. They also need `APP_URL` and `TOKEN_ENCRYPTION_KEY`. Register `<APP_URL>/api/wearables/<fitbit|oura|garmin>?action=callback` as the redirect address in each provider's developer console. A provider without keys shows *Not available*. Tokens are encrypted, stored in columns the app cannot read, and refreshed automatically; `/api/wearables/[provider]` handles connect, sync and disconnect.
- **Limits, honestly.** The Fitbit, Oura and Garmin flows follow each provider's public documentation but have not been run against live provider accounts here. Garmin's Health API is only open to approved partners. MyFitnessPal has no public API, so its data comes in through the CSV export (the `myfitnesspal_sync` source exists in the schema for a future connector). Apple Health cannot be read by a website directly, so it is a file import.
- **Database.** Migration `20261115001400_wearables_nutrition.sql` (also appended to `supabase/manual-setup.sql`) adds `wearable_connections`, `wearable_daily_metrics`, `nutrition_daily_logs` and `nutrition_targets`, unique per client/provider and client/day/provider (or source), with RLS: clients manage their own data, their coach and permitted assistant trainers can read it.
- **Jack.** `get_my_health_metrics` and `log_nutrition_summary` for clients, `get_client_wearables_and_nutrition` for coaches.
- **Tests.** `tests/wearablesNutrition.test.js` (in-process Postgres with RLS and column grants), `tests/healthImport.test.js` (MyFitnessPal CSV, Apple Health XML and zip, summaries, merging, forms, translations) and `tests/wearablesApi.test.js` (OAuth, token refresh, normalizers and sync with mocked HTTP).

## Real-time chat

- **Chat** (`/messages` for coaches, the **Chat** tab of `/coach-hub` for clients). A WhatsApp-style, two-way chat: the coach has a conversation list (last message, time, unread badge, search once there are many clients) and the open conversation; the client sees their coach. Messages appear in bubbles with the send time (full date on hover), sent / read ticks (`✓` / `✓✓`), date separators, auto-scroll to the newest message (only when you are already near the bottom, or when you send), "Load earlier messages" paging, Enter to send and Shift+Enter for a new line. A failed send shows **Retry** / **Delete**, and retrying never creates a duplicate (each message carries a `client_ref`). The sidebar shows the unread count. The coach's one-way notes and videos (the **Broadcast** tab, workflow messages, purchase thanks) also appear inside the client's conversation. Open a client's chat directly with `/messages?with=<client id>` (the Clients page uses it).
- **Live updates.** Supabase Realtime `postgres_changes` on `chat_messages` (new messages and read receipts); the screen shows *Live* or *Reconnecting…* and falls back to polling every 10 seconds while the live connection is down, then catches up when it returns. Make sure Realtime is on for the table: the migration adds it to the `supabase_realtime` publication, and if your project forbids that, enable it under Database > Replication.
- **Database and security.** Migration `20261115001500_realtime_chat.sql` (also appended to `supabase/manual-setup.sql`) adds `chat_messages (id, sender_id, receiver_id, message_text, created_at, is_read, client_ref)`. Row-level security lets only the sender and the receiver read a row; nobody can insert, edit or delete rows directly. Writing goes through `send_chat_message`, which only allows a coach and one of their own **active** clients (and a coach whose trial or subscription is active), limits text to 2000 characters and 40 messages per minute. `get_chat_messages`, `mark_chat_read`, `get_chat_conversations` and `get_chat_unread_count` serve the screens. Archived clients keep their history but cannot receive new messages until restored.
- **Jack.** Coaches: `read_client_chat` (unread overview or one conversation; it never marks messages as read) and `send_client_chat_message`. Clients: `read_coach_chat` and `send_coach_chat_message`. Assistant trainers do not use the chat; they keep sending notes through *My clients*.
- **Not included.** Push notifications for chat messages (the existing web push only covers coach-to-client notes, sessions and invoices), typing indicators, attachments, and editing or deleting sent messages.
- **Tests.** `tests/chat.test.js` runs the real schema in an in-process Postgres (RLS, direct-write refusal, link and trial checks, paging, read receipts, conversation list, rate limit, idempotent retries, the publication step, Jack's tools) plus the chat helpers, the Realtime subscription with a fake channel, and translations in all five languages.

## AI providers for Jack (Amazon Bedrock and Azure AI Foundry)

- **Who chooses.** The AI provider is the **account owner's** setting (Settings > *AI provider*, shown only to a coach with a running trial or plan). Jack then uses that choice for the coach, the coach's assistant trainers and the coach's clients, in the background. Clients and assistant trainers get no AI settings, no model list and no provider name anywhere; if the AI is not ready they only see a neutral "Jack is not available yet" message. Providers: **OpenAI**, **Google Gemini**, **Amazon Bedrock** and **Microsoft Azure AI Foundry**, or *Platform default* (the server's environment variables).
- **Amazon Bedrock** (`bedrock`). Fields: AWS region, Model ID (for example `anthropic.claude-3-5-sonnet-20241022-v2:0` or `amazon.nova-pro-v1:0`), access key ID, secret access key and an optional session token. Uses the Bedrock **Converse API** with tool use, signed with AWS Signature V4 (implemented in `api/_lib/awsSigV4.js`, checked against AWS's published example, no AWS SDK needed). The IAM user needs `bedrock:InvokeModel` and access to the model enabled in that region. Environment fallback: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `BEDROCK_MODEL_ID`.
- **Microsoft Azure AI Foundry** (`azure_foundry`). Fields: endpoint (for example `https://my-resource.services.ai.azure.com` or `https://my-resource.openai.azure.com`), deployment / model name (`gpt-4o`, `DeepSeek-R1`, `Llama-3.3-70B-Instruct`…) and API key; function calling. OpenAI models use `/openai/deployments/<name>/chat/completions`, other models the Azure AI model inference API at `/models/chat/completions`; a full `.../chat/completions` address is used as given. Only https addresses on Microsoft's Azure domains are accepted (the server calls them with your key). The model must support function calling; `DeepSeek-R1` does not on every deployment, and its `<think>` text is hidden. Environment fallback: `AZURE_FOUNDRY_ENDPOINT`, `AZURE_FOUNDRY_API_KEY`, `AZURE_FOUNDRY_MODEL`.
- **Environment selection.** `JACK_PROVIDER` can be `openai`, `gemini`, `azure_foundry` or `bedrock`; without it the first complete setup is used, in that order. Saved settings of the account owner always win over the environment.
- **Storage and secrets.** Credentials are encrypted on the server with `TOKEN_ENCRYPTION_KEY` and stored in `coach_ai_settings` (migration `20261115001600_ai_provider_settings.sql`, also appended to `supabase/manual-setup.sql`). The table has row-level security with no access for the app's roles; the owner reads and writes only through functions that refuse anyone who is not a coach with an active plan (clients and assistant trainers are refused by the database too). After saving, secrets are never sent back: the screen only shows that they are saved, and an empty field keeps the stored value. Without `TOKEN_ENCRYPTION_KEY` credentials cannot be saved (the environment fallback still works). If the key is changed the owner must enter the credentials again.
- **Test connection.** `/api/ai` (`get`, `save`, `test`, `clear`; owner only, rate limited) sends one plain request and one tool request, and reports the connection, the latency and whether tool calling works, with the provider's own explanation when it fails. Unsaved values can be tested before saving.
- **Not included.** Streaming token output from the providers (Jack streams steps and the final answer as before), Bedrock API keys / SSO / IAM roles (only access keys), Entra ID sign-in for Azure (API key only), and per-client model choice. These providers follow their public documentation and were tested here against mocked responses, not live accounts.
- **Tests.** `tests/aiProviders.test.js` (the signer against AWS's example, both adapters with tools, the whole agent loop on each, error safety, endpoint safety, the settings rules, the model Jack uses per person, owner-only visibility, translations) and `tests/aiSettingsDatabase.test.js` (the real schema: closed table, owner-only functions, whose settings apply).