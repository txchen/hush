# Hush

A personal secret vault for coding agents. Deploy it to your Cloudflare account, manage secrets in your browser, and give commands the credentials they need:

```sh
hush exec github -- gh api user
hush exec cloudflare -- wrangler deploy
```

Secret values are encrypted before they reach the server. A **Profile** maps selected secrets to environment variables; `hush exec` decrypts those values locally and passes them to the command. The CLI supports Linux x86_64, Linux ARM64, and Apple Silicon macOS.

**Getting started:** [Deploy](#deploy-your-vault) → [Create a vault](#create-your-first-secret-and-profile) → [Install the CLI](#install-the-cli) → [Connect a machine](#connect-a-machine).

## Deploy your vault

You need a Cloudflare account with Workers, D1, and Zero Trust Access, a domain managed by Cloudflare, and Node.js 24+ with npm 11 on the machine you deploy from. Choose an unused hostname such as `hush.example.com`. The Web admin and API share this hostname; no separate frontend hosting or always-on server is needed.

### 1. Get the code and create the database

```sh
git clone https://github.com/txchen/hush.git
cd hush
npm ci
(cd apps/service && npx wrangler login)
(cd apps/service && npx wrangler d1 create hush)
```

Keep the returned database ID for step 3. The database holds encrypted secret values, wrapped keys, and metadata. See Cloudflare's [D1 setup guide](https://developers.cloudflare.com/d1/get-started/) if your account needs additional setup.

### 2. Protect the hostname with Cloudflare Access

Create a [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) for `hush.example.com`, covering the entire hostname, including `/api/*` and the Web admin.

- Add an **Allow** policy restricted to your owner email. Use that same email for `OWNER_EMAIL` below.
- Configure a login method for that account.
- Copy the application's **Application Audience (AUD)** value and your Zero Trust team domain, such as `your-team.cloudflareaccess.com`.

Access sign-in authorizes you to use the service. Your Hush master password, created later, unlocks the encrypted vault. They are separate credentials.

### 3. Configure Hush

Edit [`apps/service/wrangler.jsonc`](apps/service/wrangler.jsonc). Replace its existing `vars` and `d1_databases` entries and add `routes` using your own values:

```jsonc
{
  "routes": [{ "pattern": "hush.example.com", "custom_domain": true }],
  "vars": {
    "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
    "ACCESS_AUDIENCE": "your-access-application-aud",
    "OWNER_EMAIL": "you@example.com",
    "ADMIN_ORIGIN": "https://hush.example.com",
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "hush",
      "database_id": "your-database-id",
      "migrations_dir": "migrations",
    },
  ],
}
```

This is a configuration excerpt: retain the other existing fields, including `main`, `assets`, and compatibility settings. Keep `workers_dev` and `preview_urls` disabled. `ACCESS_TEAM_DOMAIN` is a hostname without `https://`; `ADMIN_ORIGIN` includes `https://` and has no trailing slash. Never put your master password, device private key, or Access Client Secret into this file.

The route uses a Workers [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Cloudflare provisions its DNS record and certificate; choose a hostname without an existing conflicting CNAME record.

### 4. Build and deploy

Run from the repository root:

```sh
npm run build -w @hush/web
(cd apps/service && npx wrangler d1 migrations apply hush --remote)
(cd apps/service && npx wrangler deploy)
```

Open `https://hush.example.com` and sign in through Access. You should see **Create your vault**. If setup fails, see [troubleshooting](docs/operations.md#troubleshooting).

## Create your first secret and profile

1. Choose a vault name and a long, unique master password. Store the password somewhere safe; Hush has no password-reset service. **Trust this browser** is optional and allows future unlocks using a key stored on that browser.
2. In **Secrets**, add a secret named `GITHUB_TOKEN` with your GitHub token as its value.
3. In **Profiles**, create a profile named `github`. Select that secret and map it to the environment variable `GITHUB_TOKEN`.

You can add more profiles, such as `cloudflare` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Secret edits, profile changes, and device management happen in the Web admin; CLI devices have read-only service access.

## Install the CLI

Download the archive for your machine and `SHA256SUMS` from [GitHub Releases](https://github.com/txchen/hush/releases/latest). No Go or Node.js installation is needed to run the CLI.

| Machine           | Archive suffix        |
| ----------------- | --------------------- |
| Linux x86_64      | `linux_amd64.tar.gz`  |
| Linux ARM64       | `linux_arm64.tar.gz`  |
| Apple Silicon Mac | `darwin_arm64.tar.gz` |

The [CLI installation guide](apps/cli/README.md#installation) includes download, checksum verification, and installation commands for all three platforms. Linux containers need a CA certificate bundle. macOS binaries are not Developer ID signed or notarized.

## Connect a machine

Do this once on each machine that will run `hush`:

1. Create a [Cloudflare Access Service Token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) for the machine. Save its **Client ID** and **Client Secret**. In your Hush Access application, add a **Service Auth** policy that includes this token. Keep the owner's Allow policy as well.
2. Generate the machine's device key:

   ```sh
   hush init --url https://hush.example.com --name agent-server --client-id YOUR_ID.access
   ```

3. In Web admin, open **Devices → Register CLI device**. Copy the four fields printed by `hush init`: name, device ID (`id`), public key, and Access Client ID. These fields are public enrollment information; the private key stays on the machine.
4. Run `hush login` and enter the **Client Secret** at the hidden prompt. This is the Access token secret, not your master password.
5. Check the connection and run a command:

   ```sh
   hush status --json
   hush profile list --json
   hush exec github -- gh api user
   ```

Once connected, agents can run `hush exec` without interactive login. Credentials are kept in a private local file, so access to that file grants access as the device. See [CLI configuration and credential handling](apps/cli/README.md#configuration-and-local-security) for custom directories and automated provisioning.

## Day-to-day use

- **Run a command:** `hush exec <profile> -- <command> [args...]`. Profile variables override matching variables in the current environment. Arguments, standard streams, signals, and exit status are preserved.
- **Inspect available metadata:** `hush secret list --json` and `hush profile list --json`. The CLI does not offer a command to print individual secret values.
- **Remove a machine:** revoke it in Web admin to block future reads. `hush logout` only removes credentials from the local machine.
- **Update or back up your vault:** follow the [operations guide](docs/operations.md).

Every execution needs an online service. If the service is unavailable or decryption fails, Hush does not start the command. A running command can still print or use its injected secrets; Hush does not sandbox agent code or redact command output.

## What is encrypted?

Secret **values** and the vault encryption key are stored encrypted. Secret names, profile mappings, device information, and timestamps are visible to the service. A database copy alone does not directly reveal secret values, but it permits offline guessing of the master password, so password strength matters.

Read [How Hush encryption works](docs/encryption.md) for the key flow and security boundaries, or the [format-1 protocol](contracts/crypto.md) for exact algorithms and wire formats.

## Further reading

- [CLI reference](apps/cli/README.md)
- [Updates, backups, and troubleshooting](docs/operations.md)
- [Development and testing](docs/development.md)
- [API contract](contracts/openapi.yaml)
