# DSH Plugin Chengzi Account

[中文说明](README.zh.md)

Chengzi Account is the account plugin built into the Chengzi Pro flavor of [DSH Desktop](../README.md). It signs users in with a mainland China phone number and an SMS verification code, keeps the session on the Host, and shows account status in a Settings section.

## Behavior

- The Settings section **Account** (`chengzi-account`) offers phone + SMS-code sign-in, shows the phone number, the token balance, and the account provisioning status, and offers **Refresh** and **Sign out**.
- The Renderer never sees a BFF token. It calls loopback routes served by the Host web server; the Host attaches bearer headers, rotates tokens once on expiry, and clears the stored session when a refresh fails.
- SMS-code requests are throttled locally to one per phone number per minute, in addition to any server-side limit.

## Host routes

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/plugins/chengzi-account/sms-code` | Forward a verification-code request (locally throttled). |
| POST | `/plugins/chengzi-account/login` | Exchange phone + code for a session; the Host stores it. |
| POST | `/plugins/chengzi-account/logout` | Revoke the refresh token (best effort) and clear the session. |
| GET | `/plugins/chengzi-account/me` | Signed-in state, phone number, and balance; auto-refreshes once on 401. |
| GET | `/plugins/chengzi-account/api-key` | Provisioned API key view; a 409 carries `provisionState`. |

Every route applies the Connection source check before reading anything, caps request bodies, and answers with JSON only.

## Configuration

The BFF origin defaults to `https://api.chengzipro.cn` and can be overridden with the `CHENGZI_BFF_BASE_URL` environment variable (for example `http://127.0.0.1:8080` during local development; plain HTTP is accepted for loopback hosts only).

## Security

- Session tokens live only in the credential seam as one `GrantRecord` at `chengzi-account/session`, written exclusively through the seam's serialized read-modify-write, so concurrent token rotations cannot lose a write.
- Tokens never reach the Renderer, never appear in logs, and are never echoed in error messages.
- BFF responses are read with a 64 KiB ceiling; non-JSON or malformed bodies fail safely without echoing response content.
