const { exec } = require('child_process');
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require("morgan");
// const githubhook = require('express-github-webhook');
const dotenv = require("dotenv");
const path = require("path");
const crypto = require('crypto');
const fs = require('fs');
const nodemailer = require('nodemailer');
dotenv.config();

// const webhookHandler = githubhook({ path: '/deploy', secret: process.env.DEPLOY_SECRET });

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

function writeLog(message, success) {
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
  const logName = `deploy_${new Date().toISOString().replace(/:/g, '-')}_${success ? 'success' : 'fail'}.log`;
  const logFile = path.join(logDir, logName);
  fs.writeFile(logFile, message, (err) => {
    if (err) {
      console.error(err);
    } else {
      console.log(`${success ? 'Deployment successful' : 'Error while deploying'}. See logs/${logName} for details.`);
    }
  });
  sendEmail(success ? 'Deployment successful' : 'DEPLOYMENT FAILED', message, logFile);
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
  
  // Check that the branch being pushed to is the master branch
  const branch = req.body.ref.split('/').pop();
  if (branch !== 'master') {
    console.log(`[DEPLOYER] Push received on branch ${branch}. Not deploying.`);
    return res.status(200).send('OK');
  }
  
  // Execute the shell script to pull the latest changes from the master branch
  exec('cd /home/rcjadm/apps/apache/rcj_cms && git fetch && git status && git pull origin master', (err, stdout, stderr) => {
    if (err) {
      console.error(err);
      const logMessage = `Error deploying on ${new Date().toISOString()}:\n${err}\n${stderr}\n`;
      writeLog(logMessage, false);
      return res.status(500).send('Error executing shell script');
    }
    const logMessage = `Deployment successful on ${new Date().toISOString()}:\n${stdout}\n${stderr}\n`;
    writeLog(logMessage, true);
    res.status(200).send('OK');
  });
});


app.listen(process.env.HTTP_PORT, () => {
  console.log(`Deployer server listening on port ${process.env.HTTP_PORT}`);
});