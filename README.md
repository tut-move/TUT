# TUT v5 — Owner/Admin Ready

TUT is a black-and-gold capacity marketplace prototype for drivers, trucks, loads, and warehouse space.

## Run

```bash
node server.js
```

Open `http://localhost:3000`.

## First-time owner setup

1. Open **Join / Login**.
2. If no owner exists, a gold **First-time Owner Setup** panel appears.
3. Enter your own name, email, and a password of at least 10 characters.
4. Click **Create Owner Account**.
5. Owner setup then locks permanently and the **Owner** navigation tab becomes available only to the owner account.

Do not put an owner password directly into source code. Do not share passwords or verification codes in chat/screenshots.

## Owner dashboard

The owner can view platform counts, users, listings, verify users, and close listings.

## Important prototype note

This is an MVP/validation build. Sessions are stored in memory and reset when the server restarts, so the owner simply logs in again. Production deployment should use persistent sessions, a production database, HTTPS, rate limiting, CSRF protection, email verification, password reset, audit logs, backups, and jurisdiction-specific transport/compliance controls.
