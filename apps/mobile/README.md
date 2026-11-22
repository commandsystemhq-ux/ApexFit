# ApexFit mobile (Expo / React Native)

A native app for iPhone and Android that uses the **same Supabase project** and the same database rules as the web app. It lives in its own folder with its own `package.json`, so the web app and its Vercel deployment are not affected (`.vercelignore` keeps this folder out of the deployment).

## What it does

| Role | Screens |
| --- | --- |
| Coach | Clients (list, status, open a chat), Programs (list and details), Chat, Settings |
| Client | My plan (programs the coach assigned, with days and exercises), Progress (log today's weight, history), Chat, Settings |
| Both | Sign in with email and password or Google, two-way chat with live updates, **voice messages**, five languages (English, Arabic, German, French, Spanish) |

Voice messages follow the web app's rules: up to 2 minutes and 10 MB, a preview before sending, a private `apexfit-chat-audio` bucket, a short-lived signed link when someone presses play, and a message to the other person's web push devices through `/api/push`. Recordings are AAC in an MPEG-4 container (`audio/mp4`), which both platforms produce.

Building programs, invoices, campaigns and the other coach tools stay in the web app.

## Setup

You need Node 20 or newer. Run everything from this folder (`apps/mobile`).

```bash
npm install
cp .env.example .env     # then fill in the three values
npx expo start
```

`.env` (only public values; `EXPO_PUBLIC_` values are readable by anyone who installs the app, so never put the service-role key or any other secret in them):

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | the Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | the publishable (anon) key |
| `EXPO_PUBLIC_API_URL` | the address of the deployed web app, for example `https://your-app.vercel.app` |

Apply the database migrations first, including `20261115002600_chat_voice_messages.sql` (see the main README), and set up the web app's `VAPID_*` variables if you want chat push notifications to reach web devices.

## Run on a device

- **Expo Go** (quickest): scan the QR code from `npx expo start`. Chat, voice recording and email sign-in work. Google sign-in returns to an `exp://…` address in Expo Go (see deep linking below).
- **Android emulator or phone**: `npx expo run:android` (needs Android Studio and a device or emulator). This creates a development build that uses the real `apexfit://` scheme.
- **iPhone simulator or phone**: `npx expo run:ios` (needs a Mac with Xcode).

## Build for the stores

The identifiers are `com.apexfit.app` for both platforms (change them in `app.json` before the first release).

```bash
npm install --global eas-cli
eas login
eas build:configure
eas build --platform android --profile production   # .aab for Google Play
eas build --platform ios --profile production       # needs an Apple Developer account
```

Check the project at any time with `npx expo-doctor`, and that both platforms compile with `npm run export`.

## Deep linking for sign-in

The app registers the URL scheme `apexfit` (`app.json`). After Google sign-in, and after the link in a confirmation email, Supabase sends the person back to `apexfit://auth/callback`, which finishes the sign-in (PKCE code exchange; the screen is `app/auth/callback.js`).

In the Supabase dashboard, **Authentication > URL Configuration > Redirect URLs**, add:

- `apexfit://auth/callback` (development builds and store builds)
- `exp://**` (only while you test with Expo Go)

Google needs nothing extra in the app: the provider is already configured in Supabase for the web app. Test the link on a device with:

```bash
npx uri-scheme open "apexfit://auth/callback" --android
xcrun simctl openurl booted "apexfit://auth/callback"     # iOS simulator
```

Opening the callback without sign-in information shows an error with a button back to sign-in; that is expected.

## Reading direction (Arabic)

The language follows the phone, and can be changed in Settings. Texts change at once; the layout direction (right to left for Arabic) is applied after the app is closed and opened again, and the app says so.

## Notes and limits

- The session is stored in the device's secure storage (Keychain / Keystore), split into small pieces because of SecureStore's size limit.
- Row-level security and the database functions decide what each person can read or change, exactly as on the web; the app only holds the anon key.
- Push notifications **to the phone** are not included. The app triggers the web app's push for the other person after each message, but receiving pushes on a phone needs Expo / APNs / FCM setup, a device token table and a sender, which is a separate piece of work.
- Camera features (progress photos) and food search from the web app are not in the mobile app yet.
