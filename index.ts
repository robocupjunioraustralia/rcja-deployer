import Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { exec } from 'child_process';
import express from "express";
import bodyParser from "body-parser";
import morgan from "morgan";
import path from "path";
import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
import { CronJob } from "cron";
import { config } from "./config"
import { runSyncDatabases } from './functions/syncDatabases';
import { runDatabaseMigrations } from './functions/migrate';
import { setMaintenanceMode, start } from './functions/docker';
import { writeLog } from './functions/logging';
import { createDatabaseBackup, getDeploymentBackupDir } from "./functions/backup";
import type { ApiBackupResult } from "./functions/backup";
import { rebuildViews } from "./functions/docker";
import { getAllDeployments, getDeployment } from "./functions/deployment";
import type { Deployment } from "./functions/deployment";

const app = express();
app.set('trust proxy', true);
app.set('case sensitive routing', false);

if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.Express({ app }),
      nodeProfilingIntegration(),
    ],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });

  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

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

// GitHub actions endpoint for deployments of robocupjunior/RCJA_Registration_System
// Action has two secrets:
// - DEPLOY_TOKEN: Matches config.REGO_DEPLOY_SECRET for authentication
// - DEPLOY_URL: POST https://rcja.app/deploy/rego
// Expects a JSON payload with:
// - image: the SHA of the deployment
// - environment: the environment to deploy to "prod" or "staging"
app.post('/deploy/rego', async (req, res) => {
  console.log(req.body);
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.split(" ")[1] !== config.REGO_DEPLOY_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  if (!req.body.image || !/^[a-f0-9]{40}$/i.test(req.body.image)) {
    return res.status(400).send('Invalid or missing DEPLOY_SHA');
  }

  if (!req.body.environment || !["prod", "staging"].includes(req.body.environment)) {
    return res.status(400).send('Invalid or missing DEPLOY_ENV');
  }

  const targetEnv = req.body.environment === "prod" ? "production" : "staging";

  console.log(`[REGO] Received deployment request for ${req.body.image}...`)

  res.setHeader('Content-Type', 'text/plain');

  // Run config.REGO_DEPLOY_SCRIPT with a param of the sha. Pipe the output to the response.
  try {
    const deployCmd = spawn("sudo", [config.REGO_DEPLOY_SCRIPT, req.body.image, targetEnv], {
      shell: true,
      cwd: config.REGO_DEPLOY_PATH
    });

    deployCmd.stdout.on('data', (data) => {
      console.log("[REGO] " + data.toString())
      res.write(data);
    });

    deployCmd.stderr.on('data', (data) => {
      console.log("[REGO] " + data.toString())
      res.write(data);
    });

    deployCmd.on('close', (code) => {
      console.log(`[REGO] Process exited with code ${code}`);

      if (code !== 0) {
        res.write(`Process exited with code ${code}`);
        res.status(500).end();
        return;
      } else {
        // Expects last line of script to be "Deployment complete." if successful
        res.write('Deployment complete.');
        res.end();
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[REGO] Error running deployment script:", message);
    res.write(`Error running deployment script: ${message}`);
    res.status(500).end();
  }
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

  setMaintenanceMode(deployment, true);
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
    const initialStartResult = await start(deployment, true);
    deployLog += initialStartResult.log;
    if (initialStartResult.error) {
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error building/starting instance');
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

    // Rebuild the views
    console.log('[SYNC] Rebuilding views...')
    deployLog += "\n--- REBUILDING VIEWS ---\n";
    const rebuildViewsResult = await rebuildViews(deployment);
    deployLog += rebuildViewsResult.log;
    if (rebuildViewsResult.error) {
      writeLog(deployLog, false, "sync");
      return res.status(500).send('Error rebuilding views');
    }

    writeLog(deployLog, true, "deploy");
    res.status(200).send('OK');
    setMaintenanceMode(deployment, false);
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

    // An export always ends with _export
    const existingExports = fs.readdirSync(deploymentBackupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('_export.tar.gz'))
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

  const { result: backupResult, backupName } = await createDatabaseBackup(deployment, "_export");
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

if (config.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

app.listen(config.HTTP_PORT, () => {
  console.log(`Deployer server listening on port ${config.HTTP_PORT}`);
});

function triggerSyncDatabases() {
  const fromDeployment = getDeployment(config.SYNC_FROM_DEPLOYMENT, true);
  const toDeployment = getDeployment(config.SYNC_TO_DEPLOYMENT, true);
  runSyncDatabases(fromDeployment, toDeployment);
}

async function runPHPScript(filePath: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const migrateCmd = spawn(config.PHP_PATH, [filePath], { cwd: cwd, shell: true });

    let scriptLog = "";
    migrateCmd.on('exit', (code) => {
      if (code === 0) {
        return resolve(scriptLog);
      }
      reject(`PHP script exited with code ${code}:\n${scriptLog}`)
    });

    migrateCmd.on('error', (err) => {
      reject(`PHP script errored:\n${err?.message || err}\n${scriptLog}`);
    });

    migrateCmd.stdout.on('data', (data) => {
      console.log(data.toString());
      scriptLog += data;
    });

    migrateCmd.stderr.on('data', (data) => {
      console.log(data.toString());
      scriptLog += data;
    });
  });
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

    // Find and run the nightly script, if present, under path/utils/nightly.php
    const nightlyScript = path.join(deployment.path, 'utils/nightly.php');
    if (fs.existsSync(nightlyScript)) {
      console.log('[NIGHTLY] Running script...');
      nightlyLog += `[NIGHTLY] Running script...\n`;

      try {
        const scriptOutput = await runPHPScript(nightlyScript, deployment.path)
        nightlyLog += scriptOutput;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[NIGHTLY] Error running script:', message);
        nightlyLog += `[NIGHTLY] Error running script: ${message}\n`;

        writeLog(nightlyLog, false, "nightly");
        return;
      }

      console.log('[NIGHTLY] Script complete.');
      nightlyLog += `[NIGHTLY] Script complete.\n\n`;
    } else {
      nightlyLog += `[NIGHTLY] Skipping Deployment - No script found.\n\n`;
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
