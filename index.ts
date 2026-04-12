import "./instrument"; // sentry
import * as Sentry from "@sentry/node";
import bodyParser from "body-parser";
import { exec } from 'child_process';
import { CronJob } from "cron";
import crypto from 'crypto';
import express from "express";
import fs from 'fs';
import morgan from "morgan";
import path from "path";
import { createDatabaseBackup, getDeploymentBackupDir } from "./functions/backup";
import type { ApiBackupResult } from "./functions/backup";
import { runNightly, setMaintenanceMode, start, stop } from './functions/docker';
import { getAllDeployments, getDeployment } from "./functions/deployment";
import type { Deployment } from "./functions/deployment";
import { writeLog } from './functions/logging';
import { runDatabaseMigrations } from './functions/migrate';
import { syncDatabases } from './functions/syncDatabases';
import { config } from "./config"

const app = express();
app.set('trust proxy', true);
app.set('case sensitive routing', false);

app.use(bodyParser.json());
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true, parameterLimit: 50000}));
app.use(express.static(path.join(__dirname, 'public')));

morgan.token('statusColor', (req, res, args) => {
  const status = (res.headersSent ? res.statusCode : undefined) || 0;

  let color = 0; // default no color
  if (status >= 500) color = 31; // red
  else if (status >= 400) color = 33; // yellow
  else if (status >= 300) color = 36; // cyan
  else if (status >= 200) color = 32; // green

  return '\x1b[' + color + 'm' + status + '\x1b[0m';
});
app.use(morgan(':statusColor :method :url - :response-time ms - :req[x-Forwarded-For] :remote-user'));

app.get("/deploy/ping", (req, res) => {
  res.send("OK");
});

// GitHub webhook endpoint after any push requests are made to robocupjunior/rcj_cms
app.post('/deploy', async (req, res) => {
  if (!req.body) {
    return res.status(400).send('Request body is missing');
  }
  const payload = JSON.stringify(req.body);

  // Verify the request came from GitHub using the deploy secret
  const signature = req.headers['x-hub-signature'];
  if (!signature) {
    console.log('[DEPLOYER] No signature found. Not deploying.')
    return res.status(401).send('Unauthorized');
  }

  const hmac = crypto.createHmac('sha1', config.DEPLOY_SECRET);
  const digest = 'sha1=' + hmac.update(payload).digest('hex');

  if (signature !== digest) {
    console.log('[DEPLOYER] Deploy secret does not match. Not deploying.');
    return res.status(401).send('Unauthorized');
  }

  // Find a deployment matching the repository
  const deployments = getAllDeployments();
  const matchedDeployments = Object.values(deployments).filter((d) => d.repository === req.body.repository.full_name);
  if (matchedDeployments.length === 0) {
    console.log(`[DEPLOYER] No deployment found for repository ${req.body.repository.full_name}. Not deploying.`);
    return res.status(200).send('OK');
  }
  console.log(`[DEPLOYER] Received change on ${req.body.repository.full_name}...`)

  // Check that the branch being pushed to is the master branch
  const deployment = matchedDeployments.find((d) => d.branch_ref === req.body.ref);
  if (!deployment) {
    console.log(`[DEPLOYER] The branch ${req.body.ref} does not match a deployment config. Not deploying.`);
    return res.status(200).send('OK');
  }

  console.log(`[DEPLOYER] Deploying ${req.body.repository.full_name} (${req.body.ref}) to ${deployment.title}...`);
  let deployLog = `--- Deploying ${req.body.repository.full_name} (${req.body.ref}) to ${deployment.title} ---\n`;

  const maintenanceEnableResult = await setMaintenanceMode(deployment, true);
  deployLog += maintenanceEnableResult.log;
  if (maintenanceEnableResult.error) {
    writeLog(deployLog, false, "deploy");
    return res.status(500).send('Error enabling maintenance mode');
  }

  deployLog += `Deployment started on ${new Date().toISOString()}\n\n`;
  // Execute the shell script to pull the latest changes from the branch
  exec(`cd ${deployment.path} && ${deployment.pull_cmd}`, async (err, stdout, stderr) => {
    if (err) {
      console.error(err);
      deployLog += `--- Error while pulling changes ---\n${err}\n${stderr}\n`;
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error executing shell script');
    }
    console.log('[DEPLOY] Successfully pulled all changes')
    console.log(stdout, stderr);
    deployLog += `--- Successfully pulled all changes ---\n${stdout}\n${stderr}\n`;

    // Build & start the instance
    console.log('[DEPLOY] Rebuilding instance...');
    deployLog += '\n[DEPLOY] Rebuilding instance...';
    const stopResult = await stop(deployment);
    deployLog += stopResult.log;
    if (stopResult.error) {
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error stopping instance');
    }

    const initialStartResult = await start(deployment, true);
    deployLog += initialStartResult.log;
    if (initialStartResult.error) {
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error building/starting instance');
    }

    if (deployment.backup) {
      // backup the database before running migrations
      console.log('[DEPLOY] Backing up database...');
      deployLog += '\n[DEPLOY] Backing up database...';
      const backupResult = await createDatabaseBackup(deployment, false);
      deployLog += backupResult.result.log;
      if (backupResult.result.error) {
        writeLog(deployLog, false, "deploy");
        return res.status(500).send('Error backing up database');
      }
    }

    // Check for any database migrations
    console.log('[DEPLOY] Running database migrations...')
    deployLog += "\n--- RUNNING DATABASE MIGRATIONS ---\n";
    const migrateResult = await runDatabaseMigrations(deployment);
    deployLog += migrateResult.log;
    if (migrateResult.error) {
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error executing database migrations');
    }

    const maintenanceDisableResult = await setMaintenanceMode(deployment, false);
    deployLog += maintenanceDisableResult.log;
    if (maintenanceDisableResult.error) {
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error disabling maintenance mode');
    }

    writeLog(deployLog, true, "deploy");
    res.status(200).send('OK');
  });
});

type ExportRouteParams = { deployment_id: string };
type ExportRouteLocals = { deployment: Deployment };

async function canExport(
  req: express.Request<ExportRouteParams, unknown, unknown, unknown, ExportRouteLocals>,
  res: express.Response<unknown, ExportRouteLocals>,
  next: express.NextFunction
) {
  const deployment = getDeployment(req.params.deployment_id, false);
  if (!deployment) { return res.sendStatus(403); }
  if (!deployment.export) { return res.sendStatus(403); } // Exporting not enabled for this deployment

  const requestIp = req.ip?.replace('::ffff:', '');
  if (!requestIp || !deployment.export.allowed_ips.includes(requestIp)) {
    console.warn(`[EXPORT] Request from IP "${requestIp}" not allowed for deployment "${deployment.title}"`);
    return res.sendStatus(403);
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader.split(" ")[1] !== deployment.export.secret) {
    console.warn(`[EXPORT] Invalid secret for deployment "${deployment.title}" from IP "${req.ip}"`);
    return res.sendStatus(403);
  }

  res.locals.deployment = deployment;
  next();
}

function cleanupExports() {
  const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
  for (const deploymentKey in deployments_info) {
    const deploymentBackupDir = getDeploymentBackupDir(deployments_info[deploymentKey], false);
    if (!deploymentBackupDir) {
      continue;
    }

    const suffixes = ['_export.tar.gz', '_sync.tar.gz'];

    // An export always ends with _export
    const existingExports = fs.readdirSync(deploymentBackupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && suffixes.some(suffix => entry.name.endsWith(suffix)))
      .map((file) => {
        const filePath = path.join(deploymentBackupDir, file.name);
        return { file, filePath, stats: fs.statSync(filePath) };
      })
      .sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs); // oldest first

    // Keep up the 5 most recent exports as long as they are less than 1 day old
    const expiredExports = existingExports.filter((e, index) => {
      const exportAgeDays = (Date.now() - e.stats.mtimeMs) / (1000 * 60 * 60 * 24);
      return index >= 5 || exportAgeDays > 1;
    });

    for (const expiredExport of expiredExports) {
      console.log(`[CLEANUP] Deleting old export: ${expiredExport.filePath}`);
      fs.rmSync(expiredExport.filePath, { force: true });
    }
  }
}

app.post('/export/:deployment_id', canExport, async (req, res) => {
  const deployment = res.locals.deployment;

  console.log(`[DEPLOYER] Creating backup for ${deployment.title}...`);
  let exportLog = `--- Creating backup for ${deployment.title} ---\n`;

  cleanupExports();

  const { result: backupResult, backupName } = await createDatabaseBackup(deployment, true, "_export");
  exportLog += backupResult.log;

  if (backupResult.error) {
    res.status(500).setHeader('Content-Type', 'text/plain');
    res.write(exportLog);
    res.end();
    return;
  }

  res.status(200).setHeader('Content-Type', 'application/json');
  res.write(JSON.stringify({ name: backupName } satisfies ApiBackupResult));
  res.end();
});

type BackupRequest = express.Request<ExportRouteParams & { backup_name: string }>;
app.get('/export/:deployment_id/:backup_name', canExport, async (req: BackupRequest, res) => {
  const deployment = res.locals.deployment;

  const deploymentBackupDir = getDeploymentBackupDir(deployment, false);
  if (!deploymentBackupDir) {
    return res.status(404).send(`No backups found for deployment "${deployment.title}"`);
  }

  let backupName = req.params.backup_name;
  if (backupName === "latest") {
    const existingBackups = fs.readdirSync(deploymentBackupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((file) => file.name);

    if (existingBackups.length === 0) {
      return res.status(404).send(`No backups found for deployment "${deployment.title}"`);
    }

    backupName = existingBackups.sort().reverse()[0];
  }

  const backupFile = path.join(deploymentBackupDir, backupName);

  // prevent path traversal
  if (!backupFile.startsWith(deploymentBackupDir)) {
    return res.status(400).send('Invalid backup name');
  }

  if (!fs.existsSync(backupFile)) {
    return res.status(404).send(`Unable to find backup "${backupName}" for deployment "${deployment.title}"`);
  }

  console.info(`[EXPORT] Exporting backup "${backupName}"...`);
  let exportLog = `[EXPORT] Exporting backup "${backupName}"...\n`;

  // send the .tar.gz backup file as an attachment
  res.attachment(path.basename(backupFile));
  try {
    await new Promise<void>((resolve, reject) => {
      res.sendFile(backupFile, (err) => {
        if (err) { return reject(err); }
        resolve();
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[EXPORT] Error sending backup file:', message);
    exportLog += `\n[EXPORT] Error sending backup file: ${message}`;

    res.status(500).end();
    writeLog(exportLog, false, "export");
    return;
  }

  console.info(`[EXPORT] Export complete`);
  exportLog += `[EXPORT] Export complete\n`;

  writeLog(exportLog, true, "export");
});

async function triggerSyncDatabases() {
  const fromDeployment = getDeployment(config.SYNC_FROM_DEPLOYMENT, true);
  const toDeployment = getDeployment(config.SYNC_TO_DEPLOYMENT, true);

  const result = await syncDatabases(fromDeployment, toDeployment);
  writeLog(result.log, !result.error, "sync");
}

async function triggerCMSNightly() {
  const deployments = getAllDeployments();

  const nightlyStart = new Date();
  let nightlyLog = `--- Running nightly scripts on ${deployments.length} deployments ---\n`;
  nightlyLog += `[NIGHTLY] Started on ${nightlyStart.toISOString()}\n`;

  for (const deployment of Object.values(deployments)) {
    nightlyLog += `--- Deployment: ${deployment.title} ---\n`;

    if (!deployment.run_nightly) {
      nightlyLog += `[NIGHTLY] Skipping Deployment - Not enabled.\n\n`;
      continue;
    }

    const result = await runNightly(deployment);
    if (result.error) {
      nightlyLog += `[NIGHTLY] Error running nightly script:\n\n`;
      console.error(result.error.message);
      continue;
    }
  }

  const timeTaken = (new Date().getTime() - nightlyStart.getTime()) / 1000;
  console.log(`[NIGHTLY] Nightly scripts complete. Took ${timeTaken} seconds.`);
  nightlyLog += `[NIGHTLY] Nightly scripts complete. Took ${timeTaken} seconds.\n`;
  writeLog(nightlyLog, true, "nightly");
}

// Schedule jobs:
// - triggerCMSNightly - every night at 12am
// - cleanupExports - every night at 1am
// - triggerSyncDatabases - every night at 2am
const syncJob = new CronJob('0 0 2 * * *', triggerSyncDatabases);
const cleanupJob = new CronJob('0 0 1 * * *', cleanupExports);
const nightlyJob = new CronJob('0 0 0 * * *', triggerCMSNightly);
syncJob.start();
cleanupJob.start();
nightlyJob.start();

// Run the nightly script on startup
triggerCMSNightly();

if (config.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.listen(config.HTTP_PORT, () => {
  console.log(`Deployer server listening on port ${config.HTTP_PORT}`);
});
