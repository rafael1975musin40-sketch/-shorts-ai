# SHORTS AI Real v1.6

v1.6 adds a server-backed personal cabinet on top of v1.5.

## Added
- Profile modal with account email and Free/PRO status.
- PRO expiry date.
- Daily AI usage counter from PostgreSQL.
- Saved-script count from PostgreSQL.
- Recent AI activity.
- Change-password endpoint.
- Log out of all devices.
- PRO purchase shortcut.

## Run
1. Copy `.env.example` to `.env` and fill `DATABASE_URL`, `OPENAI_API_KEY` and payment credentials.
2. Start PostgreSQL: `docker compose up -d`
3. Run schema: `psql "$DATABASE_URL" -f schema.sql`
4. Install: `npm install`
5. Start: `npm start`
6. Open `http://localhost:3000`


## v1.7
Mobile-first UI: bottom navigation, responsive creator flow, compact cards and touch-friendly controls. Backend/API/database remain from v1.6.
