-- migrate:up

-- Better Auth, minimal (report J.9). These four tables are Better Auth's own
-- shape, not the domain's: the column names are the camelCase ones the library
-- writes, and the ids are text because it generates them.
--
-- They live in `public`, beside the domain schemas rather than inside one, and
-- they are deliberately not joined to `core.users` by a foreign key. Better
-- Auth owns when its tables change; `core.users` is the row the domain refers
-- to from `research.runs.user_id`. The application matches them on email, so
-- an upgrade to one never forces a migration of the other.

begin;

create table public.auth_users (
  id text primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default false,
  image text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table public.auth_sessions (
  id text primary key,
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references public.auth_users(id) on delete cascade
);
create index auth_sessions_user_idx on public.auth_sessions ("userId");

create table public.auth_accounts (
  id text primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references public.auth_users(id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  -- Hashed by Better Auth before it arrives; never a plaintext secret.
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index auth_accounts_user_idx on public.auth_accounts ("userId");

create table public.auth_verifications (
  id text primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index auth_verifications_identifier_idx on public.auth_verifications (identifier);

commit;

-- migrate:down

begin;
drop table if exists public.auth_verifications;
drop table if exists public.auth_accounts;
drop table if exists public.auth_sessions;
drop table if exists public.auth_users;
commit;
