const { exec } = require('child_process');
const express = require("express");
const morgan = require("morgan");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const CronJob = require('cron').CronJob;

const { runSyncDatabases } = require('./functions/syncDatabases');
const { runDatabaseMigrations } = require('./functions/migrate');
const { enableMaintenance, disableMaintenance } = require('./functions/maintenance');
const { writeLog } = require('./functions/logging');
const { rebuildViews } = require('./functions/rebuildViews');
const { rebuildNPM } = require('./functions/rebuildNPM');

dotenv.config();

const app = express();
app.set('case sensitive routing', false);
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true, parameterLimit: 50000}));
app.use(express.static(path.join(__dirname, 'public')));

morgan.token('statusColor', (req, res, args) => {
  var status = (typeof res.headersSent !== 'boolean' ? Boolean(res.header) : res.headersSent)
  ? res.statusCode
  : undefined

  // get status color
  var color = status >= 500 ? 31 // red
  : status >= 400 ? 33 // yellow
  : status >= 300 ? 36 // cyan
  : status >= 200 ? 32 // green
  : 0; // no color

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

  const hmac = crypto.createHmac('sha1', process.env.DEPLOY_SECRET);
  const digest = 'sha1=' + hmac.update(payload).digest('hex');

  if (signature !== digest) {
    console.log('[DEPLOYER] Deploy secret does not match. Not deploying.');
    return res.status(401).send('Unauthorized');
  }

  const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));

  // Find the repository in deployments.json
  const valid_deployments = Object.values(deployments_info).filter(d => d.repository === req.body.repository.full_name);
  if (valid_deployments.length === 0) {
    console.log(`[DEPLOYER] Repository ${req.body.repository.full_name} not found in deployments.json. Not deploying.`);
    return res.status(200).send('OK');
  }
  console.log(`[DEPLOYER] Received change on ${req.body.repository.full_name}...`)

  // Check that the branch being pushed to is the master branch
  const selected_deployment = valid_deployments.find(d => d.branch_ref === req.body.ref);
  if (!selected_deployment) {
    console.log(`[DEPLOYER] The branch ${req.body.ref} does not match a deployment config. Not deploying.`);
    return res.status(200).send('OK');
  }

  console.log(`[DEPLOYER] Deploying ${req.body.repository.full_name} (${req.body.ref}) to ${selected_deployment.title}...`);
  let deployLog = `--- Deploying ${req.body.repository.full_name} (${req.body.ref}) to ${selected_deployment.title} ---\n`;

  enableMaintenance(selected_deployment);
  deployLog += `Deployment started on ${new Date().toISOString()}\n\n`;
  // Execute the shell script to pull the latest changes from the branch
  exec(`cd ${selected_deployment.path} && ${selected_deployment.pull_cmd}`, async (err, stdout, stderr) => {
    if (err) {
      console.error(err);
      deployLog += `--- Error while pulling changes ---\n${err}\n${stderr}\n`;
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error executing shell script');
    }
    console.log('[DEPLOY] Successfully pulled all changes')
    console.log(stdout, stderr);
    deployLog += `--- Successfully pulled all changes ---\n${stdout}\n${stderr}\n`;


    // Update NPM packages and rebuild assets
    console.log('[DEPLOY] Updating NPM packages and rebuilding assets...')
    deployLog += "\n--- RUNNING NPM COMMANDS ---\n";
    const [npmFailed, npmLog] = await rebuildNPM(selected_deployment);
    console.log("[DEPLOY] NPM commands complete: ", npmFailed ? "FAIL" : "SUCCESS");
    deployLog += npmLog;
    deployLog += `\n\n--- NPM COMMANDS: ${npmFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    // Check for any database migrations
    console.log('[DEPLOY] Running database migrations...')
    deployLog += "\n--- RUNNING DATABASE MIGRATIONS ---\n";
    const [migrateFailed, migrateLog] = await runDatabaseMigrations(selected_deployment, !selected_deployment.backup);
    console.log("[DEPLOY] Migration complete: ", migrateFailed ? "FAIL" : "SUCCESS");
    deployLog += migrateLog;
    deployLog += `\n\n--- DATABASE MIGRATIONS: ${migrateFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (migrateFailed) {
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error executing database migrations');
    }
  
    // Rebuild the views
    console.log('[SYNC] Rebuilding views...')
    deployLog += "\n--- REBUILDING VIEWS ---\n";
    const [rebuildFailed, rebuildLog] = await rebuildViews(selected_deployment);
    console.log("[SYNC] View rebuild complete: ", rebuildFailed ? "FAIL" : "SUCCESS");
    deployLog += rebuildLog;
    deployLog += `\n\n--- REBUILDING VIEWS: ${rebuildFailed ? "FAIL" : "SUCCESS"} --- \n\n`;
  
    if (rebuildFailed) {
      writeLog(deployLog, false, "sync");
      console.error("[SYNC] View rebuild failed");
      return res.status(500).send('Error rebuilding views');
    }

    writeLog(deployLog, true, "deploy");
    res.status(200).send('OK');
    disableMaintenance(selected_deployment);
  });
});

app.listen(process.env.HTTP_PORT, () => {
  console.log(`Deployer server listening on port ${process.env.HTTP_PORT}`);
});

function triggerSyncDatabases() {
  const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
  const fromDeployment = deployments_info[process.env.SYNC_FROM_DEPLOYMENT];
  const toDeployment = deployments_info[process.env.SYNC_TO_DEPLOYMENT];
  runSyncDatabases(fromDeployment, toDeployment);
}

async function runPHPScript(filePath, cwd) {
  return new Promise((resolve, reject) => {
    const migrateCmd = spawn(process.env.PHP_PATH, [filePath], { cwd: cwd });

    let scriptLog = "";
    migrateCmd.on('exit', (code) => {
      if (code === 0) {
        return resolve(scriptLog);
      }
      reject(`PHP script exited with code ${code?.message || code}:\n${scriptLog}`)
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
  const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
  const deployments = Object.values(deployments_info);
  
  const nightlyStart = new Date();
  let nightlyLog = `--- Running nightly scripts on ${deployments.length} deployments ---\n`;
  nightlyLog += `[NIGHTLY] Started on ${nightlyStart.toISOString()}\n`;

  for (const deployment of deployments) {
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
        console.error('[NIGHTLY] Error running script:', err?.message || err);
        nightlyLog += `[NIGHTLY] Error running script: ${err?.message || err}\n`;

        writeLog(nightlyLog, false, "nightly");
        return;  
      }
      
      console.log('[NIGHTLY] Script complete.');
      nightlyLog += `[NIGHTLY] Script complete.\n\n`;
    } else {
      nightlyLog += `[NIGHTLY] Skipping Deployment - No script found.\n\n`;
    }
  }

  console.log(`[NIGHTLY] Nightly scripts complete. Took ${(new Date() - nightlyStart) / 1000} seconds.`);
  nightlyLog += `[NIGHTLY] Nightly scripts complete. Took ${(new Date() - nightlyStart) / 1000} seconds.\n`;
  writeLog(nightlyLog, true, "nightly");
}

// Schedule jobs:
// - triggerCMSNightly - every night at 12am
// - triggerSyncDatabases - every night at 2am
const syncJob = new CronJob('0 0 2 * * *', triggerSyncDatabases);
const nightlyJob = new CronJob('0 0 0 * * *', triggerCMSNightly);
syncJob.start();
nightlyJob.start();

// Run the nightly script on startup
triggerCMSNightly();
