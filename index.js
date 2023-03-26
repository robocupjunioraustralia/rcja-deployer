const { exec } = require('child_process');
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require("morgan");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require('crypto');
const fs = require('fs');
const nodemailer = require('nodemailer');

const { rebuildViews } = require('./functions/rebuildViews');
const { syncDatabases } = require('./functions/syncDatabases');
const { anonymiseDatabase } = require('./functions/anonymiseDatabase');
const { createDatabaseBackup } = require('./functions/backup');
const { runDatabaseMigrations } = require('./functions/migrate');
const { enableMaintenance, disableMaintenance } = require('./functions/maintenance');

dotenv.config();

const app = express();
app.set('case sensitive routing', false);
app.use(bodyParser.json());
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

function writeLog(message, success, type) {
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
  const logName = `${type}_${new Date().toISOString().replace(/:/g, '-')}_${success ? 'success' : 'fail'}.log`;
  const logFile = path.join(logDir, logName);
  fs.writeFile(logFile, message, (err) => {
    if (err) {
      console.error(err);
    } else {
      if (type == 'deploy') {
        console.log(`${success ? 'Deployment successful' : 'Error while deploying'}. See logs/${logName} for details.`);
      } else if (type == 'sync') {
        console.log(`${success ? 'Sync successful' : 'Error while syncing'}. See logs/${logName} for details.`);
      }
    }
  });
  if (type == 'deploy') {
    sendEmail(success ? 'Deployment successful' : 'DEPLOYMENT FAILED', message, logFile);
  } else if (type == 'sync') {
    sendEmail(success ? 'Sync successful' : 'SYNC FAILED', message, logFile);
  }
}

function sendEmail(subject, message, attachment) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    }
  });
  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: process.env.SMTP_TO,
    subject: subject,
    text: message,
    attachments: attachment ? [{ filename: path.basename(attachment), path: attachment }] : [],
    priority: "high"
  };
  transporter.sendMail(mailOptions, (err, info) => {
    if (err) {
      console.error(err);
    } else {
      console.log(`[DEPLOYER] Email sent: ${info.response}`);
    }
  });
}

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
    const [migrateFailed, migrateLog] = await runDatabaseMigrations(selected_deployment, false);
    console.log("[DEPLOY] Migration complete: ", migrateFailed ? "FAIL" : "SUCCESS");
    deployLog += migrateLog;
    deployLog += `\n\n--- DATABASE MIGRATIONS: ${migrateFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (migrateFailed) {
      writeLog(deployLog, false, "deploy");
      return res.status(500).send('Error executing database migrations');
    }

    writeLog(deployLog, true, "deploy");
    res.status(200).send('OK');
    disableMaintenance(selected_deployment);
  });
});

async function runSyncDatabases() {
  const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
  const fromDeployment = deployments_info[process.env.SYNC_FROM_DEPLOYMENT];
  const toDeployment = deployments_info[process.env.SYNC_TO_DEPLOYMENT];

  console.log(`[SYNC] Syncing ${fromDeployment.title} to ${toDeployment.title}...`);
  let syncLog = `--- Syncing ${fromDeployment.title} to ${toDeployment.title} ---\n`;

  enableMaintenance(toDeployment);
  syncLog += `\n[SYNC] Started on ${new Date().toISOString()}\n\n`;
  
  const [syncFailed, newSyncLog] = await syncDatabases(fromDeployment, toDeployment);
  syncLog += newSyncLog;
  syncLog += `\n[SYNC] Finished on ${new Date().toISOString()}\n\n`
  syncLog += `\n\n--- SYNC: ${syncFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

  if (syncFailed) {
    writeLog(syncLog, false, "sync");
    console.log("[SYNC] Sync failed");
    return; 
  }

  // Because we have copied from production, some database changes might not have been applied
  // We need to run the migrations again to ensure that the database is up to date
  console.log('[SYNC] Running database migrations...')
  syncLog += "\n--- RUNNING DATABASE MIGRATIONS ---\n";
  const [migrateFailed, migrateLog] = await runDatabaseMigrations(toDeployment, true);
  console.log("[SYNC] Migration complete: ", migrateFailed ? "FAIL" : "SUCCESS");
  syncLog += migrateLog;
  syncLog += `\n\n--- DATABASE MIGRATIONS: ${migrateFailed ? "FAIL" : "SUCCESS"} --- \n\n`;
  
  if (migrateFailed) {
    writeLog(syncLog, false, "sync");
    console.error("[SYNC] Migration failed");
    return; 
  }

  // Anonymise the database
  console.log('[SYNC] Anonymising database...')
  syncLog += "\n--- ANONYMISING DATABASE ---\n";
  const [anonymiseFailed, anonymiseLog] = await anonymiseDatabase(toDeployment);
  console.log("[SYNC] Anonymisation complete: ", anonymiseFailed ? "FAIL" : "SUCCESS");
  syncLog += anonymiseLog;
  syncLog += `\n\n--- ANONYMISING DATABASE: ${anonymiseFailed ? "FAIL" : "SUCCESS"} --- \n\n`;
  
  if (anonymiseFailed) {
    writeLog(syncLog, false, "sync");
    console.error("[SYNC] Anonymisation failed");
    return; 
  }

  // Rebuild the views
  console.log('[SYNC] Rebuilding views...')
  syncLog += "\n--- REBUILDING VIEWS ---\n";
  const [rebuildFailed, rebuildLog] = await rebuildViews(toDeployment);
  console.log("[SYNC] View rebuild complete: ", rebuildFailed ? "FAIL" : "SUCCESS");
  syncLog += rebuildLog;
  syncLog += `\n\n--- REBUILDING VIEWS: ${rebuildFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

  if (rebuildFailed) {
    writeLog(syncLog, false, "sync");
    console.error("[SYNC] View rebuild failed");
    return;
  }
  
  writeLog(syncLog, true, "sync");
  console.log("[SYNC] Sync complete")
  disableMaintenance(toDeployment);
};

app.listen(process.env.HTTP_PORT, () => {
  console.log(`Deployer server listening on port ${process.env.HTTP_PORT}`);
});

// Schedule the runSyncDatabases function to run every night at 12am
const CronJob = require('cron').CronJob;
const job = new CronJob('0 0 0 * * *', runSyncDatabases);
job.start();
