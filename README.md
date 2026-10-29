# PingTalk backend

The backend is a separate Express 5 API. Prisma ORM 7.10 uses its PostgreSQL
driver adapter, and Better Auth owns email/password credentials, password
hashing, and sessions. The API never accepts a client-supplied user ID as
authentication.

## Requirements

- Node.js 20.19+, 22.12+, or 24+
- PostgreSQL
- The configured `backend/.env` and frontend `pingtalk/.env.local`

Do not replace an existing `.env` or `.env.local` when configuring a deployment.
The checked-in `.env.example` contains placeholders only.

## Local setup

From `Pingtalk/backend/`, install dependencies and generate the Prisma client:

```powershell
npm install
npm run db:generate
npm run db:migrate -- --name init
npm run dev
```

The migration command creates and applies a migration; it does not reset or drop
the database. Check an existing database's migration status with
`npm run db:status` before deploying schema changes. Production deployments
should use `npm run db:deploy`.

The environment file must set `NODE_ENV`, `PORT`, `FRONTEND_URL`,
`CORS_ORIGIN`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`.
`DIRECT_URL` is optional for local use and selects the direct PostgreSQL
connection for Prisma CLI operations when present; `DATABASE_URL` remains the
application runtime connection.
`CORS_ORIGIN` must be the exact frontend origin (without a path or trailing
slash), and the auth secret must contain at least 32 characters. Startup
validation reports variable names only; it never prints configured values.

From `Pingtalk/pingtalk/`, set `NEXT_PUBLIC_API_URL` in `.env.local` to the
backend origin, then run `npm install` and `npm run dev`. The default local
development URL is `http://localhost:5000`. Start the frontend and backend in
separate terminals.

## Render deployment

Use the backend repository with Root Directory `.` and a Node.js release
supported by Prisma 7.10.1 (20.19+, 22.12+, or 24+). Render sets `PORT` for the
web service, and the server listens on that port without restricting the
network interface. Render sets `RENDER=true`; on Render, Express trusts exactly
one proxy hop so `express-rate-limit` can use the forwarded client IP without
enabling unrestricted proxy trust. The existing one-hop Railway configuration
is also preserved.

Set the Render build command to `npm run build`, the start command to
`npm start`, and the health-check path to `/api/health`. Configure
`NODE_ENV=production`, `FRONTEND_URL`, matching exact `CORS_ORIGIN`,
`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and the frontend's `NEXT_PUBLIC_API_URL`.
For Neon, use its pooled connection string as `DATABASE_URL` for the running
application and its direct (non-pooled) connection string as `DIRECT_URL` for
Prisma CLI migration operations. The Prisma config falls back to `DATABASE_URL`
when `DIRECT_URL` is unset, which keeps existing local setup working; set
`DIRECT_URL` before production schema deployments.

The health endpoint verifies that the API process is responsive; it does not
perform a database connectivity check. No database migration is run as part of
the application build or start commands.

## API

- `GET /api/health`: liveness status; does not expose database connection data.
- Better Auth endpoints: `/api/auth/*` (email sign-up/sign-in, sign-out, and
  session retrieval).
- Authenticated profile endpoints: `GET/PATCH /api/me` and
  `GET /api/users/:userId`. Profile edits are limited to display name, image URL,
  and status message; public profiles never include email or auth fields.
- `GET /api/users?query=...&limit=20&cursor=...` searches by name/email, omits
  the current user, returns only public fields, and uses bounded cursor pages.
- `GET /api/conversations?limit=20&cursor=...` returns the member's recent
  conversations, latest message preview, unread count, and bounded pages.
  `POST /api/conversations/private` retrieves or creates the unique private
  conversation for the authenticated user pair.
- `POST /api/conversations/groups` creates a named group with 1-49 other
  members. Owners/admins can add participants and update the group name; owners
  and admins can remove non-owners. Group size is capped at 50. Members can
  leave; when the owner leaves, ownership transfers to the longest-standing
  member. A final member leaving deletes the now-empty group and its messages.
- Group details are available at `GET /api/conversations/:id`, with separately
  paginated participants at `GET /api/conversations/:id/participants`.
- Messages are sent at
  `POST /api/conversations/:id/messages`, fetched with cursor pagination at
  `GET /api/conversations/:id/messages`, and edited/deleted through
  `PATCH/DELETE /api/messages/:id`. Read receipts are updated through
  `POST /api/messages/:id/read` or `POST /api/conversations/:id/read`.

Protected endpoints require the Better Auth session cookie. Conversation
membership is checked on every conversation/message operation. User search may
match email addresses but returns only user IDs, names, and avatar URLs.

## Cookies and production origins

The frontend auth and API clients send credentials. Locally, they call the
backend at `http://localhost:5000`. In production, Next.js proxies browser
requests under `/api/*` to `NEXT_PUBLIC_API_URL`, making the browser-facing
requests same-origin and avoiding dependence on third-party cookies between
the default Vercel and Render domains. The backend CORS configuration still
allows only the exact configured frontend origin with credentials.

Better Auth cookies remain `HttpOnly` and `SameSite=Lax`; they are `Secure` in
production. Keep HTTPS enabled. The authentication UI confirms the server
session before opening the chat, so a failed cookie/session request produces
an error instead of briefly showing the chat.

## Database design

Better Auth's `User`, `Session`, `Account`, and `Verification` models are kept
alongside the product schema. `UserProfile` stores optional app-specific
profile data separately. A nullable unique private-conversation key prevents
duplicate one-to-one conversations; group and private conversations share
conversation memberships and message storage. Memberships, role checks,
foreign keys, unique read receipts, bounded pagination, and soft message
deletion are implemented in the API.

## Tests and checks

```powershell
npm run db:status
npm run db:generate
npm run build
npm run lint
npm test
```

The tests cover health output, exact-origin CORS, error responses,
unauthenticated access, authorization policies, and input validation. The
configured PostgreSQL service was also used for cleaned-up Better Auth
sign-up/session/sign-in/sign-out, profile/search privacy, pagination, private
conversation reuse, group creation/management/ownership transfer, message
history/edit/delete, member authorization, and read-receipt smoke tests.
Temporary test accounts and conversations were deleted afterward.

## Future realtime transport

No Socket.IO or LiveKit server is enabled. A future Socket.IO handshake should
pass the request cookies to Better Auth's `auth.api.getSession`, reject
connections without a valid session, and derive the user ID only from that
verified session. Before joining or broadcasting to a conversation room, query
the current conversation membership and authorize the requested operation on
the server.
