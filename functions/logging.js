const path = require("path");
const fs = require('fs');
const nodemailer = require('nodemailer');

function writeLog(message, success, type) {
    const logDir = path.join(__dirname, '../logs');
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
            } else if (type == 'nightly') {
                console.log(`${success ? 'Nightly script successful' : 'Error while running nightly script'}. See logs/${logName} for details.`);
            } else if (type == 'import') {
                console.log(`${success ? 'Import successful' : 'Error while importing'}. See logs/${logName} for details.`);
            }
        }
    });
    if (type == 'deploy') {
        sendEmail(success ? 'Deployment successful' : 'DEPLOYMENT FAILED', message, logFile);
    } else if (type == 'sync') {
        sendEmail(success ? 'Sync successful' : 'SYNC FAILED', message, logFile);
    } else if (type == 'nightly') {
        sendEmail(success ? 'Nightly script successful' : 'NIGHTLY SCRIPT FAILED', message, logFile);
    } else if (type == 'import') {
        sendEmail(success ? 'Import successful' : 'IMPORT FAILED', message, logFile);
    }
}

function sendEmail(subject, message, attachment) {
    if (!process.env.SMTP_HOST) {
        console.log('[DEPLOYER] SMTP not configured, skipping email sending');
        return;
    }

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

module.exports = {
    writeLog,
    sendEmail
}
