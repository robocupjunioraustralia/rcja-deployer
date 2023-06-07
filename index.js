const { exec } = require('child_process');
const express = require("express");
const morgan = require("morgan");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require('crypto');
const fs = require('fs');

const { runSyncDatabases } = require('./functions/syncDatabases');
const { runDatabaseMigrations } = require('./functions/migrate');
const { enableMaintenance, disableMaintenance } = require('./functions/maintenance');
const { writeLog } = require('./functions/logging');
const { rebuildViews } = require('./functions/rebuildViews');

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
app.use(morgan(':statusColor :method :url - :response-time ms - :remote-addr :remote-user'));

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

// Schedule the triggerSyncDatabases function to run every night at 12am
const CronJob = require('cron').CronJob;
const job = new CronJob('0 0 0 * * *', triggerSyncDatabases);
job.start();
