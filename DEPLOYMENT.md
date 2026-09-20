# Deploying the Consolidate demo to Railway

Goal: a public HTTPS URL (like `https://consolidate-production.up.railway.app`) that a judge can open from any computer, sign in
with a demo password, and use the real chat, Context Trace and Dashboard, with your laptop turned off.

This is a **private, password-protected demo**, not a SaaS launch. One shared password, one server, one SQLite file on a volume.

## What is already done in this repository

| Item | Status |
|---|---|
| Login gate: visitors get a login screen, never the app. HTTP-only, SameSite=Strict, Secure cookie, 12 h expiry, Log out button | done |
| Every data and model route rejects requests without a session (401) | done |
| `GET /api/health` (public, SQLite only, never calls Anthropic, exposes nothing) | done |
| Production refuses to start unless configured correctly (Anthropic provider, key, models, password, database on the volume) | done |
| Developer/failure-injection controls disabled in production, even if `CONSOLIDATE_DEV_TOOLS=1` is set by mistake | done |
| Rate limits on model spend; benchmark mode limited much harder; one-shot in the UI | done |
| Request-size guard before paid generation | done |
| `railway.toml` (start command, healthcheck, 1 replica), `.node-version`, `.env.example` | done |
| SQLite on a persistent volume: WAL, idempotent migrations, survives restarts | done and tested |

Nothing has been deployed and no Railway account was touched.

## One-time steps (you do these)

### Part 1: put the code on GitHub

1. Check that no secret or database is about to be committed:
   ```bash
   git status --short
   ```
   You must **not** see `.env.local`, any `*.db` file, `.consolidate/` or `scratchpad/` (they are git-ignored). You **should** see `.env.example`, `railway.toml`, `DEPLOYMENT.md`.
2. Commit and push (create an empty **private** repository on github.com first, then use its URL):
   ```bash
   git add -A
   git commit -m "Consolidate demo"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

### Part 2: create the Railway project

3. Sign in at railway.com, then **New Project** and **Deploy from GitHub repo**, and select the Consolidate repository.
   (Allow Railway's GitHub app access to that repo if asked.)
4. Railway starts a first deploy immediately. **It will fail.** That is expected: the variables are not set yet, and the deploy log
   will say `Consolidate cannot start: it is misconfigured for production` and list what is missing. Continue below.

### Part 3: volume, variables, domain

5. **Add a volume** to the service (on the project canvas: right-click, then **Volume**, or press ⌘K and type "volume"; attach it to the Consolidate service).
6. Set the volume's **mount path** to `/data`.
7. Open the service's **Variables** tab (Raw Editor is easiest) and add these. Type your own values; do not paste them anywhere else:

   | Variable | Value |
   |---|---|
   | `MODEL_PROVIDER` | `anthropic-api` |
   | `ANTHROPIC_API_KEY` | your Anthropic API key (enter it **directly in Railway**) |
   | `ANTHROPIC_MODEL` | `claude-sonnet-5` |
   | `ANTHROPIC_UTILITY_MODEL` | `claude-haiku-4-5` |
   | `CONSOLIDATE_DB_PATH` | `/data/consolidate.db` |
   | `CONSOLIDATE_DEMO_PASSWORD` | a demo password you invent (at least 8 characters, ideally 16+; you will give it to the judges) |
   | `CONSOLIDATE_DEV_TOOLS` | `0` |
   | `CONSOLIDATE_ECONOMICS_MARGIN` | `1.5` |

   Optional (defaults are fine): `CONSOLIDATE_MAX_REQUEST_TOKENS`, `CONSOLIDATE_CHAT_LIMIT_PER_10_MIN`, `CONSOLIDATE_CHAT_LIMIT_PER_HOUR`,
   `CONSOLIDATE_BENCHMARK_LIMIT_PER_HOUR`, `CONSOLIDATE_SESSION_HOURS`, `CONSOLIDATE_SESSION_SECRET`. See `.env.example`.
   Do not set `PORT`: Railway provides it. Do not set `CONSOLIDATE_ALLOW_EPHEMERAL_DB`.
8. **Settings → Deploy**: confirm **Healthcheck Path** is `/api/health` (it comes from `railway.toml`) and **Replicas** is **1**.
   Do not scale above 1: SQLite is a single-writer file, and the "one message at a time per conversation" lock lives in the server process.
9. **Deploy** (Railway redeploys automatically when variables change; otherwise use Deployments → Redeploy). Wait for the deployment to
   turn **Active**. The build takes a couple of minutes.
10. **Settings → Networking → Generate Domain** (a public domain on `*.up.railway.app`). If it asks for a port, use the one Railway
    detected. This gives you the final **HTTPS URL**.

### Optional: preload the two measured demo conversations

`demo-data/demos.db` holds "Demo — Enterprise Employee" and "Demo — Mom & Pop Website" with their real, provider-counted runs (synthetic
conversations, no secrets). After the first successful deploy (so the app has created and migrated `/data/consolidate.db`), run once:

```bash
railway ssh
npm run import-demos -- /data/consolidate.db
```

It is idempotent, adds rows only, and runs in a single transaction. Locally: `npm run import-demos` (uses `CONSOLIDATE_DB_PATH`).

### Part 4: check it like a judge would

11. Open the URL in an **incognito/private window**. You should see the **Demo access** login screen and nothing else.
12. Enter a wrong password (it must say "Incorrect password"), then the right one.
13. Click **New chat** if needed, send one message (for example "In two sentences, what is a hackathon?"). The answer should stream in.
14. Read the **Context Trace** on the right: "Counted by Anthropic", the four sections, decision cards.
15. Open the **Dashboard** tab: the request you just made should be counted.
16. Prove persistence: in Railway click **Redeploy**. When it is Active again, reload the URL. Your conversation and the dashboard numbers
    should still be there (you may need to sign in again if you changed the password).
17. Click **Log out**: you should land on the login screen.
18. Visit `https://<your-domain>/api/health` without signing in: it should show `{"status":"ok","database":"ok"}`.

## Safety limits (set your own spend cap too)

* **Set a spend limit in the Anthropic Console** for the project/key you use. The app's limits below reduce risk; only the Console
  limit is a hard stop on your bill.
* Rate limits (in memory, single instance; a restart resets counters):
  * chat messages: 20 per visitor per 10 minutes, and 120 per hour across the whole demo
  * benchmark runs: 3 per visitor per hour, and 6 per hour across the whole demo
  * sign-in attempts: 8 per visitor per 10 minutes
  * exceeding a limit returns HTTP 429 with a `Retry-After` header and a message
* Request guard: a request whose provider-counted size exceeds `CONSOLIDATE_MAX_REQUEST_TOKENS` (default **100000**) is refused with
  HTTP 413 **before** any paid generation. Nothing is truncated and no protected context is removed to make it fit.
* **Benchmark mode** generates an extra full-context answer, so it roughly doubles the cost of that message. It is off by default,
  must be ticked for each message (it resets after sending), and has the stricter limit above.
* All visitors share one demo account and one set of conversations. Anyone with the password can see everything.

## Redeploy, roll back, back up

**Redeploy after a code change:** push to the branch Railway watches (`git push`), and Railway builds and deploys automatically.
To redeploy the same code: Deployments → the latest deployment → ⋯ → **Redeploy**. A redeploy of a service with a volume has a short
downtime while the old instance stops and the new one starts.

**Roll back:** Deployments → pick the last good deployment → ⋯ → **Rollback**. This restores the *code* only. Data on the volume is not
rolled back. Database migrations only add columns and tables, so older code keeps working with a newer database.

**Back up the database.** Do **not** just copy `/data/consolidate.db`: recent writes may still be in the `-wal` file.
* Easiest: use Railway's volume **Backups** feature if your plan offers it.
* Or take a consistent snapshot from inside the service (Railway CLI: `railway ssh`):
  ```bash
  npm run backup -- /data/backups/consolidate-$(date +%F).db
  ```
  This uses SQLite `VACUUM INTO`, is safe while the app is running, and refuses to overwrite an existing file. It stays on the same volume,
  so also copy it off (for example `railway ssh -- cat /data/backups/<file>.db > backup.db`, if your CLI supports that).

**Rotate the password / sign everyone out:** change `CONSOLIDATE_DEMO_PASSWORD` in Railway and redeploy. All existing sessions stop working.
(Logging out only clears the browser's cookie; sessions are stateless, so a stolen cookie stays valid until it expires, at most 12 hours.)

## What must NEVER be committed to GitHub

* `.env.local` or any `.env*` file other than `.env.example` (git already ignores them)
* your `ANTHROPIC_API_KEY` or the demo password, anywhere, in any file, issue or chat
* any `*.db`, `*.db-wal`, `*.db-shm` file, the `.consolidate/` folder, or the `scratchpad/` folder (they contain real conversations)
* screenshots or logs that show the key or password

If a key is ever committed or pasted somewhere public, revoke it in the Anthropic Console immediately and create a new one.

## How production is configured (reference)

* Build and start: `npm run build`, `npm start` (`next start`, which listens on all interfaces at Railway's `PORT`). Node 22 (`.node-version`).
* Startup checks (`instrumentation-node.ts`): in production the server exits with a clear message unless `MODEL_PROVIDER=anthropic-api`,
  the key, both model names, the password (8+ characters) and an absolute `CONSOLIDATE_DB_PATH` are set. On Railway it also refuses to
  start if no volume is attached or the database path is outside the volume (otherwise every deploy would erase your data). The messages
  name variables and never print their values. Escape hatch: `CONSOLIDATE_ALLOW_EPHEMERAL_DB=1` (data is lost on every deploy).
* Authentication: `lib/auth.ts`. Signed cookie `consolidate_session`; the password is checked only on the server and never reaches the browser.
  Auth is always on in production (a missing password locks everything, it never opens it) and optional locally.
* Local development is unchanged: `npm run dev` with `.env.local` works as before (no password unless you set one).
* Health: `GET /api/health` returns 200 `{"status":"ok","database":"ok"}` or 503 `{"status":"error","database":"error"}` with no detail.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Deploy fails; log says "Consolidate cannot start" | Read the listed variables and fix them in Railway, then redeploy |
| Log says "No Railway volume is attached" | Add the volume (mount `/data`) to the service, then redeploy |
| Healthcheck fails | Check the deploy log for the message above; `/api/health` must return 200 |
| Everyone gets logged out after a change | You changed `CONSOLIDATE_DEMO_PASSWORD` (or `CONSOLIDATE_SESSION_SECRET`); sign in again |
| "Rate limit reached" (HTTP 429) | Wait the number of seconds shown, or raise the limit variables |
| "This request would send about N tokens..." (HTTP 413) | Start a new conversation, or raise `CONSOLIDATE_MAX_REQUEST_TOKENS` |
