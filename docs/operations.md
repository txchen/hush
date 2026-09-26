# Operating Hush

Start with the [deployment and first-use guide](../README.md). This page covers an existing installation.

## Update the service

Keep your deployment's `apps/service/wrangler.jsonc` settings: database ID, Access settings, and custom domain. Review release notes and reconcile those settings with configuration changes when pulling new code; do not replace them with repository placeholders.

After updating your checkout, run from its root:

```sh
npm ci
npm run build -w @hush/web
(cd apps/service && npx wrangler d1 migrations apply hush --remote)
(cd apps/service && npx wrangler deploy)
```

These commands update the Web admin and API together and reuse the existing database. Back up before upgrades that change storage. The GitHub Actions workflow tests and builds Hush but does not deploy it to your account.

To update an npm CLI installation, run `npm install -g @txchen/hush@latest`, then `hush version`. For a standalone installation, replace the executable with the matching verified archive from [GitHub Releases](https://github.com/txchen/hush/releases/latest). Keep its configuration directory to retain the enrolled identity; do not run `logout` as an upgrade step.

## Backups

Export D1 from `apps/service/` to a private path outside this repository:

```sh
npx wrangler d1 export hush --remote --output /private/backup/hush.sql
```

Use a directory you own with restrictive permissions. The export includes encrypted values, key wraps, and readable metadata; anyone holding it can attempt offline master-password guessing. Cloudflare also documents [D1 backup and recovery](https://developers.cloudflare.com/d1/reference/time-travel/).

A database backup does not contain your master password or device private keys. Keep the master password separately. Do not treat a copied CLI credential file as an ordinary database backup: it can grant immediate device access.

Restoring an older database can also restore old key wraps, credentials bindings, or revocation state. Review device access after recovery; a restore cannot retract secrets already disclosed or recover writes made after the backup.

## Devices and password changes

Use **Devices** in the Web admin to register, rename, or revoke clients. Each CLI installation needs its own Access Service Token and public key registration. All active CLI devices can read the vault's encrypted secrets; Profiles select which values a command receives, rather than restricting what a device is authorized to fetch.

A normal revoke blocks future service reads. Revocation with key rotation also replaces the vault encryption key and excludes the revoked device from the new wraps. Neither can take back plaintext or keys already copied. If an external token was exposed, replace that token with its provider too.

Use **Settings** to change the master password or rotate the vault key. A password change wraps the same key under the new password; it does not invalidate an old database copy protected by the previous password. See [password changes and rotation](encryption.md#password-changes-and-key-rotation).

When an Access Client Secret expires or is rotated, run `hush login` again with the replacement secret. If the Client ID stays the same, the existing Hush device registration can remain. A new Client ID requires a new device enrollment. Cloudflare's [service-token guide](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) describes expiration and rotation.

## Limits

Each deployment serves one owner and one vault. It supports:

| Resource                                           | Limit                                |
| -------------------------------------------------- | ------------------------------------ |
| Secrets                                            | 500                                  |
| Secret value                                       | 12,184 UTF-8 bytes before encryption |
| Profiles                                           | 100                                  |
| Mappings per profile                               | 500                                  |
| Active devices                                     | 50                                   |
| Retained device records, including revoked devices | 500                                  |

CLI environment values cannot contain NUL bytes. Cloudflare account quotas and production performance are separate from these application limits.

## Troubleshooting

| Symptom                                                        | Check                                                                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Web says the service needs configuration, or API returns `503` | Replace placeholder Access settings and owner email in `wrangler.jsonc`, then redeploy.                                                      |
| Browser cannot sign in                                         | Confirm the Access application covers the correct hostname, has a working login method, and allows your owner email.                         |
| CLI is redirected to a login page or reports non-JSON data     | Add the machine's token to a **Service Auth** policy on the same Access application. A human Allow policy alone is insufficient.             |
| API rejects the Access identity                                | Check the team domain and application AUD against the configured application, and confirm the owner email or machine token is correct.       |
| CLI reports access denied                                      | Check token validity, the Service Auth policy, and whether the Client ID is registered as an active Hush device.                             |
| CLI cannot unwrap its key                                      | Ensure Web admin registered the public key from this installation's `hush init`, not a different machine or a previous initialization.       |
| Web reads work but writes fail                                 | Match `ADMIN_ORIGIN` exactly to the browser's HTTPS origin, without a trailing slash.                                                        |
| CLI reports unsafe credential storage                          | The directory must belong to the current user with mode `0700`; credential files must be regular owned files with mode `0600`, not symlinks. |
| TLS fails in a container                                       | Install trusted CA certificates and check the system clock and hostname.                                                                     |
| Web reports that the vault changed                             | Refresh and retry the operation against the current state.                                                                                   |
| A secret cannot be deleted                                     | Remove its Profile mappings first.                                                                                                           |
| CLI cannot find the target command                             | Install that command and check `PATH`, or use an explicit path such as `./tool`.                                                             |

The Web **Database** page shows raw stored rows without decrypting them. **Audit log** records service operations, such as ciphertext fetches; it cannot prove whether a client decrypted or viewed a secret. Browser sessions lock after 15 minutes of inactivity; a trusted browser can unlock again using its stored key.
