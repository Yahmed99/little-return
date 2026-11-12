# Little Return — cloud setup

Plain HTML, CSS, and JavaScript; no build or server application required.

Projects can hold several completed goals. Time is tracked while a project is open and visible, completed goals remain in the project history, and finished projects appear in the completed-project gallery. Existing browser records are treated as in-progress projects. Cloud users should rerun `supabase-setup.sql` to add the project fields; existing rows receive empty history, zero tracked time, and an in-progress status.

1. Create a project at https://supabase.com/dashboard (or use your existing project).
2. Run `supabase-setup.sql` in its SQL Editor. This creates sessions, all four ownership policies, and a private `progress-photos` bucket with ownership policies and a 1 MB image limit. If reusing a database, audit any existing policies: permissive RLS policies combine with OR.
3. In `supabase-config.js`, set `url` to the project URL and `anonKey` to its **publishable** (`sb_publishable_…`) or legacy **anon** key. This is public browser configuration, protected by RLS. Never use a secret or service-role key. A static site does not read `.env`; do not serve `.env` or `.git` in production. The existing `.env` was left unchanged.
4. Enable Email auth and new user signups under Authentication. Keep the default magic-link email template using `{{ .ConfirmationURL }}`. Configure Site URL and allowed Redirect URLs to include `http://localhost:8000/` and your exact production URL. Use HTTPS in production. Configure production SMTP and email rate limits before launch.
5. Serve only the public files (see below). The SDK is loaded from a pinned CDN version; failure leaves guest mode working.

## Test locally

Create a public-only staging directory, then serve it. Rerun the copy after editing:

```sh
mkdir -p /tmp/little-return-preview
cp index.html styles.css script.js supabase-config.js /tmp/little-return-preview/
python3 -m http.server 8000 --bind 127.0.0.1 --directory /tmp/little-return-preview
```

Open http://localhost:8000/ (use the same hostname in Supabase redirect settings).

- With the key blank or the CDN blocked, choose hobbies, suggest a goal, save notes/photo, reload, and reopen it. Guest mode should still work.
- Name a project, start its goal, leave and resume it, and confirm tracked time accumulates without counting time while the page is hidden. Complete a goal and choose both “Continue this project” and “Finish project”; the first should retain the same project and goal history, and the second should place it in the completed gallery.
- Enter an email and open the magic link. Confirm the account indicator, then import guest progress explicitly. Repeated import should not overwrite existing imported cloud sessions.
- Create a new cloud session; save notes and a JPEG/PNG/WebP under 1 MB. Reload and reopen it. Confirm the row and `<user-id>/<session-id>/…` object in the dashboard.
- Sign in on another browser/device: the same sessions and photo should load. Open-session fetches the current database row.
- Update notes and replace/remove a photo. Sign out and back in: ownership and saved progress should remain. Signed-out home should show only guest sessions.
- Disconnect networking after sign-in; save notes/photo. Expect “saved only on this browser,” then reload, reconnect, and use **Sync pending saves**. Failed saves with full/blocked browser storage must leave edits on screen.
- With two separate accounts, verify account B cannot select/update/delete A's session, insert a row with A's user ID, read A's photo, or upload to A's folder (use each account's authenticated client in DevTools). Anonymous requests must also fail. Test these against the actual project before production.
- Test at a 375px viewport, keyboard navigation, invalid email, expired magic link, sign-in/sign-out failures, and invalid/oversized photo selection.

## Storage and tradeoffs

Supabase is the signed-in source of truth; browser caches are scoped per account and kept separate from the original guest key `little-return-v1`. The SDK stores auth credentials in browser storage, as normal for a static client application. Signing out hides account caches but does not erase them: do not use shared browser profiles for sensitive notes.

Pending saves require explicit retry; they are never silently uploaded to a different account. Guest import retains the original guest copy and uses stable per-account IDs to avoid duplicate imports. Hobby preferences stay browser-local; a new device derives hobbies from cloud sessions (or offers all three).

Concurrent saves use last-write-wins. Pending offline edits take precedence locally and overwrite the cloud version only when the user chooses sync. There is no background sync or realtime subscription; refresh loads cloud changes. Photos use temporary signed URLs valid for one hour; reopen a session to refresh. Photo replacement cleans up the old object after a successful row save; interrupted uploads and photo removals can leave unreferenced private files, which can be cleaned up later. Database and Storage writes are separate operations.

The SQL includes delete policies; the existing interface has no delete-session action. No new delete UI was added.

Official references: [email magic links](https://supabase.com/docs/reference/javascript/auth-signinwithotp), [Storage policies](https://supabase.com/docs/guides/storage/security/access-control), [signed photo URLs](https://supabase.com/docs/reference/javascript/storage-from-createsignedurl).

## Validation performed

JavaScript syntax (`node --check script.js`) and patch whitespace checks passed. The app was served over localhost and rendered in Firefox at 375px width. Browser checks passed for guest creation/notes, unchanged goal suggestions, explicit and repeated import, cloud note wiring, offline fallback/retry, account isolation and return, photo upload paths and removal. Supabase calls in these browser checks were mocked; real email delivery, database persistence, RLS, and Storage authorization have **not** been verified against a live project. A valid public key and the applied SQL are required to complete the checklist above. The pinned SDK CDN URL was fetched successfully.

## Task timer

Opening an unfinished goal starts a countdown using its planned minutes. Pause/Resume controls exclude breaks. The timer pauses while the tab is hidden and resumes on return only if it was running. At zero it counts overtime; completion is always your choice. Saving or completing a goal stops the timer and persists the project total through the existing save flow. Completed goals keep time checkpoints in `task_history`, so the next goal gets a fresh countdown without resetting the project's total. No additional database columns are needed. For older goals without a checkpoint, existing tracked time is treated as time on the current goal until it is completed.
