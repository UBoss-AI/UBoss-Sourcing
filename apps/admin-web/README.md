# UBOSS Admin Panel

React + TypeScript admin panel for the UBOSS Sourcing backend.

## Running it

The backend must be running first — this app is a pure client and has no
server of its own.

```bash
# terminal 1
cd backend
npm run dev            # http://localhost:4000

# terminal 2
cd apps/admin-web
npm install
npm run dev            # http://localhost:5173
```

Sign in with a seeded account (see `backend/docs/HANDOFF.md`), e.g.
`owner@uboss.local` / `OwnerDev!2026`.

**The port matters.** The backend's CORS allowlist names
`http://localhost:5173` exactly, from `ADMIN_WEB_ORIGIN` in `backend/.env`.
Vite is configured with `strictPort: true` so it fails loudly rather than
silently moving to 5174 and leaving every request blocked by CORS.

## Configuration

`.env` (copy from `.env.example`):

| Variable | Meaning |
|---|---|
| `VITE_API_BASE_URL` | API base, no trailing slash. Default `http://localhost:4000/api/v1` |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on 5173 |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview` | Serve the built output |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint, zero warnings allowed |
| `npm run verify` | typecheck + lint + build |

## How auth works here

Read `src/lib/api.ts` before touching anything that talks to the API.

- Access and refresh tokens are **httpOnly cookies**. This app cannot read them
  and must not try. Every request sends `credentials: 'include'`.
- The `uboss_csrf` cookie is the one cookie readable by JavaScript. Its value
  is copied into the `x-csrf-token` header on every unsafe method. Without it
  the backend returns `FORBIDDEN` on every write.
- A 401 triggers **one** refresh, shared by every request that hit 401 at the
  same time. Firing a refresh per request rotates the refresh token repeatedly
  and the backend's reuse detection kills the session.
- Nothing about the session is stored in `localStorage`. A cached user would
  outlive a revoked session and show a full navigation to someone who has been
  signed out.

## Money

Amounts arrive as `{ minor: string, formatted: string, currency: string }`.
`minor` is a **string** because a paisa-precise total can exceed `2^53` minor
units. Use the helpers in `src/lib/format.ts`; never `Number(minor) / 100`.

## Permissions

`src/lib/permissions.ts` mirrors the backend's 40 permission keys. It decides
what the UI *shows*. It decides nothing about what the UI is *allowed* to do —
every route is enforced server-side. A nav item the user lacks permission for
is not rendered at all, rather than shown disabled.

## Accessibility rules this codebase holds to

- A skip link is the first focusable element on every page.
- Focus moves to `<main>` on navigation, because a single-page app never
  reloads and a screen reader would otherwise never learn the page changed.
- Every input has a real `<label for>`. A placeholder is not a label.
- Errors are tied to their field with `aria-describedby` and announced with
  `role="alert"` — never colour alone.
- `:focus-visible` styling is global and must not be removed.
- `prefers-reduced-motion` is honoured in `src/index.css`.

## Layout

```
src/
  app/          router, query client, error boundary
  auth/         session provider, context, route guards
  components/   UI primitives, toasts
  layout/       app shell, navigation map
  lib/          API client, formatting, permission keys
  pages/        one file per screen
```

Contexts live in their own `*-context.ts` files, separate from the providers.
A file that exports both a component and a hook cannot keep its state across a
Fast Refresh edit, which logs you out on every save.
