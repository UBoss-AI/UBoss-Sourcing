# Putting the three front ends on Netlify

This is for showing the product to somebody who is not at your computer — a
manager, a customer, a reviewer — on URLs they can open and use. It puts the
storefront, the admin console and the carrier portal on Netlify, one site each,
and points all three at your API.

`docs/DEPLOYMENT.md` is the other document, and it is the one to read for a real
installation: a server of your own, the database, backups, monitoring and the
compliance work. This one is narrower on purpose.

---

## The one thing to understand before anything else

**Netlify serves files. It does not run the API.**

Three of the five programs in this system are front ends — folders of HTML,
JavaScript and CSS, which is exactly what a static host is for. The other two
are not:

| Program | What it is | Can Netlify host it? |
|---|---|---|
| Storefront (`apps/customer-web`) | Built files | Yes |
| Admin console (`apps/admin-web`) | Built files | Yes |
| Carrier portal (`apps/logistics-web`) | Built files | Yes |
| API (`backend`) | A long-running Fastify server holding a MariaDB connection pool | **No** |
| Worker (`backend`, `start:worker`) | A process that polls the job queue forever | **No** |

So the API has to be reachable at a public URL of its own before any of this is
useful. Deploy the three sites without one and you get three applications that
render their sign-in screens and cannot sign anybody in — which looks like a
broken deployment and is actually a missing half.

**Where the API can live:**

- **A server you rent.** The real answer. `docs/DEPLOYMENT.md` §10 onwards is
  the whole procedure — a VPS, MariaDB, nginx, a certificate, systemd units.
- **A tunnel from this machine.** The API keeps running on your computer and
  gets a public HTTPS URL. Genuinely useful for showing somebody the product
  this afternoon, and genuinely not a deployment: it works only while your
  machine is on, and the database is whatever you have been developing against.
  Say so out loud when you send the link. **Use `cloudflared`, not ngrok** —
  the next section is why.

Either way, what you need from it is one string: the API's public base URL, with
a scheme, no trailing slash and no path. For example
`https://api.your-company.com`.

### Tunnelling the API: cloudflared, and why not ngrok

`SETUP.md` uses ngrok to share the *dev servers*, and that works because a
person clicks through ngrok's warning page once in their own browser. **Behind
Netlify it does not work at all**, and the way it fails is worth knowing so
nobody spends an afternoon rediscovering it.

ngrok's free plan answers any request carrying a browser `User-Agent` with an
interstitial warning page — `ERR_NGROK_6024` — *including* `fetch()` calls
asking for JSON. Netlify's proxy forwards the visitor's own `User-Agent`, so
every single API call comes back as ngrok's HTML instead of data. The site
loads and nothing in it works.

The documented escape is an `ngrok-skip-browser-warning` request header, and it
does work — but it has to be on the request *arriving* at ngrok, and Netlify's
redirect rules cannot add request headers. Adding it with an ngrok traffic
policy (`add-headers`) does not help either: that runs after the interstitial
has already been decided. Both were tried. A paid ngrok plan removes the
interstitial and is a perfectly good answer if you want a stable hostname.

`cloudflared` has no interstitial, needs no account, and costs nothing:

```powershell
winget install --id Cloudflare.cloudflared
& "$env:ProgramFiles(x86)\cloudflared\cloudflared.exe" tunnel --protocol http2 --url http://localhost:4000
```

It prints a `https://<four-words>.trycloudflare.com` URL. That is your
`-ApiOrigin`.

**`--protocol http2` is not optional on a network that blocks outbound UDP
7844.** cloudflared prefers QUIC, and when QUIC is blocked the tunnel still
registers and every request through it returns **Cloudflare error 1033** — "the
host is configured as a Cloudflare Tunnel, but Cloudflare is currently unable to
reach it". It reads like the tunnel is down. It is not; it is dialling a port
the network refuses. cloudflared says so in its own start-up precheck
(`UDP Connectivity … fail`, `suggested_protocol=http2`), which is the line to
look for.

A quick tunnel takes a **new hostname every restart**, so re-pack when it
changes — one command, a few seconds, because the API's address is not in the
JavaScript:

```powershell
.\scripts\pack-netlify.ps1 -ApiOrigin https://<new-name>.trycloudflare.com -SkipBuild
```

---

## How the pieces connect

The browser must see **one origin**. That is not a preference, it is what makes
the sign-in work.

A session here is an httpOnly cookie plus a double-submit CSRF token, and the
cookies are `SameSite=Lax`. If the storefront at
`https://shop.netlify.app` called an API at `https://api.your-company.com`
directly, every request would be cross-site, the browser would leave the cookies
behind, and the API would answer `UNAUTHORIZED` to a customer who had just
signed in successfully. Making *that* work needs `SameSite=None`, an exact CORS
allowlist and a cookie domain spanning both hosts — three more things to get
right, each of them silent when wrong.

So instead:

```
browser ──► https://shop.netlify.app/api/v1/cart   (same origin: cookies are sent)
                     │
                     │ Netlify proxy rule, status 200
                     ▼
            https://api.your-company.com/api/v1/cart
```

Two consequences worth holding on to:

- **No hostname is baked into the JavaScript.** `apps/*/.env.netlify` sets
  `VITE_API_BASE_URL=/api/v1` — relative — so the bundle asks whichever host
  served it. Only `netlify.toml` knows where the API is, which means pointing
  these sites at a different API is a re-pack and never a rebuild.
- **The cookies stay `SameSite=Lax`.** Nothing about the security model has to
  be loosened to put the UI on a static host.

---

## Route A — connect the repository (what to use once it is settled)

Netlify builds from a branch and redeploys on every push.

Do this **three times**, once per application:

1. **Add new site → Import an existing project**, and pick the repository.
2. **Base directory**: `apps/customer-web` (then `apps/admin-web`, then
   `apps/logistics-web`). This is the step that is easy to skip and breaks
   everything — Netlify reads `netlify.toml` from the base directory, and a site
   left at the repository root builds the wrong thing or nothing at all.
3. Leave the build command and publish directory alone. `netlify.toml` in each
   app already says `npm run build:netlify` and `dist`, and pins Node 24.
4. **Edit `netlify.toml`** in that app and replace
   `https://uboss-api.example.com` with your API's URL, in every `[[redirects]]`
   block. Commit it.

It is a placeholder rather than a working default because a wrong-but-plausible
URL fails at runtime, in a browser, on the one screen nobody opened — and a
placeholder fails at the first request.

---

## Route B — drag a zip in (what to use to show somebody today)

No repository access needed, nothing to connect, and it deploys in about a
minute.

```powershell
.\scripts\pack-netlify.ps1 -ApiOrigin https://api.your-company.com
```

That builds all three and writes three archives to `output/netlify`:

```
uboss-customer-web.zip
uboss-admin-web.zip
uboss-logistics-web.zip
```

Each one contains that application's built files at the root of the archive plus
a `netlify.toml` with your API origin already substituted in. In Netlify:
**Sites → Add new site → Deploy manually**, and drop **one zip per site**. Three
zips, three sites.

**The zip's `netlify.toml` is not the same file as the one in `apps/*/`, and the
difference is not cosmetic.** A manual deploy reads netlify.toml in full —
redirects, headers *and* the build command — so a zip carrying
`command = "npm run build:netlify"` makes Netlify try to build the site it was
just handed. The zip is the built output: no `package.json`, no source, nothing
to run. The deploy dies with

```
Command failed with exit code 254: npm run build:netlify
Build failed due to a user error: Build script returned non-zero exit code: 2
```

and publishes nothing. `pack-netlify.ps1` therefore cuts the `[build]` and
`[build.environment]` blocks out on the way into the zip, between the
`# >>> BUILD SETTINGS` / `# <<< BUILD SETTINGS END` markers in each app's file.
Those markers are a pair; the script refuses to pack an app whose netlify.toml
has lost them, rather than shipping a zip that fails on Netlify.

To point the same bundles at a different API — a tunnel that was re-issued, a
staging API, the real one — re-pack rather than rebuild:

```powershell
.\scripts\pack-netlify.ps1 -ApiOrigin https://abc123.ngrok-free.dev -SkipBuild
```

`-SkipBuild` reuses each `dist/`, because the JavaScript does not contain the
API's address and a rebuild would produce the same bytes.

The script takes `-Apps` to pack only some of them, and `-OutDir` to write them
somewhere else. Run it with no `-ApiOrigin` and it warns, keeps the placeholder
and still produces zips — useful for looking at the interface, useless for
signing in.

---

## What to change on the API side

None of the above works until the API knows about these three new URLs. In
`backend/.env`:

| Setting | Value | What goes wrong without it |
|---|---|---|
| `COOKIE_SECURE` | `true` | Netlify is HTTPS. A cookie without `Secure` is dropped by the browser, so sign-in returns 200, the screen does nothing, and there is no error anywhere |
| `COOKIE_SAME_SITE` | `lax` — already correct | — |
| `CUSTOMER_WEB_ORIGIN` | add the storefront's Netlify URL | Nothing, *while* every call goes through the proxy — the browser sees one origin, so CORS is never consulted. It is the safety net for the moment something does go direct, and it costs one comma |
| `ADMIN_WEB_ORIGIN` | add the console's URL | as above |
| `LOGISTICS_WEB_ORIGIN` | add the portal's URL | as above |
| `CUSTOMER_WEB_PUBLIC_URL` | the storefront's URL | Every verification, password-reset and order email links to `localhost` — that is, to the *recipient's* own machine |
| `ADMIN_WEB_PUBLIC_URL` | the console's URL | Staff invitations cannot be accepted |
| `LOGISTICS_WEB_PUBLIC_URL` | the portal's URL | Carrier invitations cannot be accepted |
| `API_PUBLIC_URL` | the API's own public URL | Payment webhooks and payment links call back to the wrong place, so orders are never confirmed |

**Restart the API afterwards.** These are read once, at boot, and validated
there — the process refuses to start on a bad value rather than misbehaving
later.

The origin settings are comma-separated lists, so the localhost entries can stay
alongside the new ones while you are still developing.

---

## Before you send the console's link to anybody

**The admin console is not a public website.** It is where prices, orders,
refunds, staff accounts and gateway credentials are changed, and a Netlify URL
is a URL anybody can reach. The sign-in wall is the only thing in front of it.

**Rotate the seeded passwords before the first link goes out**, whatever else
you do:

```powershell
cd backend ; npm run db:rotate-seed-passwords
```

README lists those accounts under *Development sign-ins*, which means they are
published in this repository — `owner@uboss.local` and its password are a
search away for anybody who finds the site. The command replaces all nine with
random ones, revokes every session, and prints the new passwords once. Nothing
brings the old ones back, including a re-seed.

That is the floor, not the finish. Netlify's own password protection or an
access policy belongs in front of the site as well (both are paid features),
and before there is anything real behind it, delete these accounts and create
real ones from **Staff** — README, *Going live*, step 11.

The carrier portal is signed into by people outside your company by design, so
it is meant to be reachable — but it is still a sign-in wall in front of
shipment data, and the same reasoning about seeded accounts applies.

---

## When something does not work

| What you see | What it is |
|---|---|
| Blank page, console shows 404s for `/assets/…` | The zip was built by something that wrote Windows path separators into it. `pack-netlify.ps1` writes forward slashes deliberately; `Compress-Archive` does not. Re-pack with the script |
| A reload on `/account/orders/123` gives Netlify's 404 | The single-page-application fallback is missing. `netlify.toml` has to be at the root of the deploy, beside `index.html` — check the site's file browser in Netlify |
| A manual zip deploy runs a **build** and fails with `exit code 254: npm run build:netlify` | The zip's netlify.toml still has a `[build]` section. Netlify honours it on manual deploys too, and there is no source in a zip to build. Re-pack with `pack-netlify.ps1`, which cuts it out — do not hand-zip a `dist/` with the repo's netlify.toml copied in |
| Sign-in returns 200 and nothing happens | Almost always `COOKIE_SECURE=false` on an HTTPS site. The browser accepted the response and discarded the cookie |
| Every API call returns HTML about visiting a site "served for free through ngrok.com" | ngrok's free interstitial, `ERR_NGROK_6024`. It cannot be worked around from Netlify's side. Use `cloudflared`, or a paid ngrok plan |
| Every API call returns Cloudflare **error 1033** | The cloudflared tunnel registered but cannot be reached — outbound UDP 7844 is blocked and it is trying QUIC. Restart it with `--protocol http2`. Its own start-up precheck says so: `UDP Connectivity … fail` |
| It worked yesterday and today every call 404s or times out | A `trycloudflare.com` quick tunnel takes a new hostname every restart. Re-pack with the new one and redeploy |
| Every request fails with a CORS error | The request is not going through the proxy. Check that `VITE_API_BASE_URL` in the bundle is relative — a build made with plain `npm run build` bakes in `http://localhost:4000/api/v1` and will not work anywhere but your machine |
| `/api/v1/…` returns Netlify's 404 page | The proxy rule is below the `/*` catch-all, or missing. Netlify takes the first rule that matches, so a rule added below the catch-all is dead and dead silently |
| Product images are broken, everything else works | The `/media/*` proxy, when the API stores files itself (`STORAGE_DRIVER=local`). The carrier portal has no such rule because it shows no product images |
| It works on the production URL and not on a Deploy Preview | Deploy Previews get a new hostname each time, which is not on the API's origin allowlist. That is the allowlist doing its job |
| Blank page after a release, fixed by a hard refresh | A cached `index.html` pointing at the previous deploy's fingerprinted files. The `Cache-Control` header in `netlify.toml` prevents this; check it was not dropped |

---

## What is deliberately not here

- **Netlify Functions.** The API is not rewritten to run as functions. It holds
  a database connection pool and a job queue, and both want a process that
  stays alive.
- **The worker.** Scheduled orders are charged, emails are sent and webhooks are
  delivered by a process that polls forever. It runs wherever the API runs.
- **Source maps.** `npm run build:netlify` turns them off. `npm run build`
  leaves them on, which is right for a server you control and wrong for a public
  static host — `sourcemap: true` publishes every `.ts` and `.tsx` file in the
  application next to the bundle, readable by anyone who opens devtools.
- **An enforced Content-Security-Policy.** The header ships as
  `Content-Security-Policy-Report-Only`, exactly as
  `deploy/nginx/snippets/uboss-security-headers.conf` does, and for the same
  reason: a policy one directive short does not degrade, it blanks the page.
  Watch the reports for a day across browsing, checkout, image search and the
  warehouse map, then rename the header.
