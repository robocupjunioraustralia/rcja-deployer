# RCJA Deployer

This is a tool used for managing deployments of the RCJ CMS ([robocupjunioraustralia/rcj_cms](https://github.com/robocupjunioraustralia/rcj_cms))

> [!NOTE]
> This version of the deployer is compatible with RCJ CMS versions `v26.1.0` and above. \
> If the CMS instance hasn't been updated to at least `v25.4.2`, return to the [previous deployer release](https://github.com/robocupjunioraustralia/rcja-deployer/releases/tag/25.4.2) first.

The deployer is responsible for:
- Handling RCJ CMS release deployments triggered by a webhook from GitHub
- Syncing databases between deployments nightly (e.g. for production to staging refreshes)

As a development tool, it also provides some CLI scripts to manage deployments: (see [CLI Scripts](#cli-scripts) for details)
- `npm run update` to rebuild the instance and run database migrations for a deployment
- `npm run backup` to create a database backup for a deployment
- `npm run import` to import a local or remote database to a deployment
- `npm run sync` to manually trigger a database sync between deployments

## Requirements

- Node.js 20 or above
- `git` command line tool available in PATH
- `docker` and `docker compose` command line tools available in PATH

## Installation

1. Install dependencies
   ```bash
   npm install
   ```

1. Copy `.env.sample` to `.env` and fill it in with your config
   ```bash
   cp .env.sample .env
   ```

1. Copy `deployments.sample.json` to `deployments.json` and fill it in with your deployment config
   ```bash
   cp deployments.sample.json deployments.json
   ```

## Configuration

When using the deployer for development only, you may not need to fill in all configuration options.

You can run the CLI scripts independently, they use the same config files as the service started by `npm start`.
Required fields when only using the CLI scripts are marked with an asterisk `*`.

### Environment Variables

The configuration from `.env` is read using `config.ts`.

Required fields:

- `HTTP_PORT`: Port for the web server to listen on
- `DEPLOY_SECRET`: Authorization secret matching the 'x-hub-signature' header from a GitHub webhook
- *`SYNC_FROM_DEPLOYMENT`: The deployment key to copy databases from for the sync job / `npm run sync`
- *`SYNC_TO_DEPLOYMENT`: The deployment key to copy databases to for the sync job / `npm run sync`

Optional fields:
- `SMTP_*`: SMTP configuration to send job logs / error reports via email
- `SENTRY_DSN`: To enable error reporting to Sentry

### Deployment Configuration

The configuration from `deployments.json` is read using `functions/deployment.ts`.

Each key in `deployments.json` identifies one deployment. The value should include:

Required fields:

- *`title`: Human-readable name of the deployment
- *`path`: Local path to the deployment files (where `docker-compose.yml` is located)
- `repository`: For incoming webhook events, git repository filter for the deployment
- `branch_ref`: For incoming webhook events, git branch ref filter for the deployment
- `pull_cmd`: For incoming webhook events, the shell command to use to pull the latest changes

Optional fields:
- `backup`: Whether or not to backup the database before running migrations when triggered by a webhook
- `export`: To allow this instance to be exported via /export/{deploymentKey}
  - `allowed_ips`: An array of allowed IPs that can trigger the export
  - `secret`: A bearer token required to trigger exports via the API
- `import`: The remote instance details to use when using the import tool
  - `remote_host`: base URL of the remote instance to import from
  - `deployment`: the deployment key on the remote instance to import from
  - `secret`: Bearer token matching the export secret of the remote deployment

## Running The Service

Start the deployment listener / scheduled jobs runner:

```bash
npm start
```

The server listens on `HTTP_PORT` and starts two scheduled jobs:
- export cleanup runs at 01:00
- database sync runs at 02:00

## CLI Scripts

Most CLI scripts accept an optional deployment key as the first non-flag argument. \
If omitted, the first deployment in `deployments.json` is used.

### Update

Runs any new migration scripts for a deployment, and optionally rebuilds the instance prior.

```bash
npm run update -- master
```

When migrations span multiple compatible releases, the deployer will attempt to step through each intermediate release sequentially (requires the target deployment to have a clean working directory).

### Backup

Create a backup for a deployment:

```bash
npm run backup -- master
```

Create an anonymised backup:

```bash
npm run backup -- master --anonymise
```

Backups (.tar.gz files) are written to `backups/{deploymentKey}/`

### Import

Restore a backup into a deployment:

```bash
npm run import -- staging
```

Follow the prompts, you can choose from one of three import sources:

- Local backup created by the deployer in `backups/{deploymentKey}/`
- Local `.tar.gz` backup file (containing SQL files) from elsewhere on the filesystem
- Remote backup fetched from an external deployment (using the `import` config of the deployment)

CAUTION: The import tool will overwrite the target deployment's databases

### Sync

Synchronise the databases between two deployments:

```bash
npm run sync
```

This uses `SYNC_FROM_DEPLOYMENT` and `SYNC_TO_DEPLOYMENT` from `.env`, then:

- Enables maintenance mode on the target
- Creates an anonymised backup of the source
- Imports that backup to the target
- Runs any required database migrations on the target
- Disables maintenance mode
