> **STATUS: CURRENT but PHASE 2 (Dylan's Zoom track).** NOT part of the local all-TS harness being
> built now — Zoom is a later adapter swap. Local-build implementers can ignore this. See [AGENTS.md](./AGENTS.md).

# Zoom Meeting SDK — Setup & De-Risk Checklist

> Consolidated from three research passes against developers.zoom.us (2026-06-26).
> Goal: get the headless Linux Meeting SDK bot able to join a meeting, with zero
> review/approval and zero surprise costs before the hackathon (June 28–29).

## TL;DR

- **Use the Meeting SDK.** Not Zoom Apps, not the REST API, not the Zoom MCP — none of
  those carry real-time audio/screenshare (see "Wrong turns" below).
- **A free Basic account is enough.** No paid plan required for the POC. (Zoom staff confirmed.)
- **Host the demo meeting from the same account that owns the app.** As of **March 2, 2026**,
  apps joining meetings *outside* their own account must be authorized (ZAK / On-Behalf-Of /
  RTMS) — the heavy path. Within your own account = no authorization, no review.
- **No app publishing or Security Review** is needed for your own-account development.

## The two hard constraints (internalize these)

1. **Own-account meetings only (no-review path).** Joining a meeting hosted by anyone else now
   triggers the March 2 2026 authorization requirement. → The presenter hosts the demo meeting
   on the dev account; the bot joins it as a guest.
2. **Free Basic accounts cap group meetings at 40 minutes.** Fine for a recorded demo (do it in
   one sub-40-min take). If you want headroom, one month of Workplace Pro removes the cap — optional.

## Wrong turns (do NOT set these up)

- **Zoom Apps / "General app for in-client apps"** (`/docs/zoom-apps/create`) — OAuth redirect
  URLs, scopes, and a **Security Review submission**. Heavier, wrong credentials for our bot.
- **Zoom REST API** — control plane (schedule/manage/fetch recordings). No live media.
- **Zoom MCP** — same control plane wrapped as AI tools (search past meetings, AI Companion
  summaries). Gated on AI Companion being enabled. No live media. Not our product.

## Setup — do this before writing any code

1. **Account + role.** Use a Zoom account you control (free Basic is fine). The account
   **owner/admin** can develop by default. If a non-owner will develop, an admin enables the
   unified **"Zoom for developers"** role permission:
   `Zoom web portal → User Management → Roles → (role) → Edit → Role Settings → Advanced
   features → check View + Edit for "Zoom for developers" → Save`.
   *(The old granular OAuth/Chatbot/Meeting-SDK permission toggles are deprecated — consolidated
   into this one permission.)* This is the only step with possible human-in-the-loop latency.
2. **Create the app.** Marketplace → **Develop → Build App → General app → Create**.
3. **Enable the SDK.** On the app's **Features → Embed** tab, toggle **Meeting SDK** on.
4. **Grab credentials.** **Basic Information** page → copy the **development** Client ID + Secret
   (there are separate dev vs prod credentials; dev is all you need).
5. **Download the Linux SDK.** Get the Linux Meeting SDK package from the Marketplace and place
   it in `lib/zoomsdk` — the binaries are NOT in the sample repo.
6. **Smoke test (the real de-risk).** Feed the creds into the headless sample; it generates the
   Meeting SDK JWT (HS256, `appKey` = Client ID — traced in `Zoom.cpp:84`) and joins via
   `SDK_UT_WITHOUT_LOGIN` (guest, no login) with meeting number + passcode. Join a meeting **you
   host on that same account**. Stay 10+ min, confirm audio receive works and you aren't kicked.
   If this passes, the entire credential → JWT → join path is proven before any build.

## What you explicitly do NOT need

- App publishing / Marketplace listing
- Zoom Security Review (as long as you host the meeting)
- OAuth redirect URLs / scopes (that's the Zoom Apps path)
- A separate Zoom account/login for the bot (it joins as a guest)
- Any paid plan (free Basic suffices for the POC)

## Sources

- Get credentials: https://developers.zoom.us/docs/meeting-sdk/get-credentials/
- Add Meeting SDK (Embed): https://developers.zoom.us/docs/meeting-sdk/create/
- App credentials (dev vs prod): https://developers.zoom.us/docs/build-flow/basic-info/app-credentials/
- Role permissions (unified "Zoom for developers"): https://developers.zoom.us/docs/build-flow/role-permissions/
- Build Platform account / pricing (Video SDK, not Meeting SDK): https://developers.zoom.us/docs/build/account/
- Free-account confirmation (Zoom staff): https://devforum.zoom.us/t/can-the-zoom-meeting-sdk-app-be-used-for-free-or-do-i-need-to-buy-a-developer-business-plan/137403
- March 2 2026 outside-account authorization: https://developers.zoom.us/docs/meeting-sdk/
- API vs MCP (the wrong tools for media): https://developers.zoom.us/docs/mcp/apis-vs-mcp/
