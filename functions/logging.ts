import path from "path";
import fs from 'fs';
import nodemailer from 'nodemailer';
import { config } from '../config';

export function writeLog(message: string, success: boolean, type: 'deploy' | 'sync' | 'import' | 'export') {
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
            } else if (type == 'import') {
                console.log(`${success ? 'Import successful' : 'Error while importing'}. See logs/${logName} for details.`);
            } else if (type == 'export') {
                console.log(`${success ? 'Export successful' : 'Error while exporting'}. See logs/${logName} for details.`);
            }
        }
    });
    if (type == 'deploy') {
        sendEmail(success ? 'Deployment successful' : 'DEPLOYMENT FAILED', message, logFile);
    } else if (type == 'sync') {
        sendEmail(success ? 'Sync successful' : 'SYNC FAILED', message, logFile);
    } else if (type == 'import') {
        sendEmail(success ? 'Import successful' : 'IMPORT FAILED', message, logFile);
    } else if (type == 'export') {
        sendEmail(success ? 'Export successful' : 'EXPORT FAILED', message, logFile);
    }
}

export function sendEmail(subject: string, message: string, attachment: string | null = null) {
    if (!config.SMTP_HOST) {
        console.log('[DEPLOYER] SMTP not configured, skipping email sending');
        return;
    }

    const transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT ? Number(config.SMTP_PORT) : undefined,
        secure: config.SMTP_SECURE === true || config.SMTP_SECURE === 'true',
        auth: {
            user: config.SMTP_USER,
            pass: config.SMTP_PASSWORD
        }
    });

    const mailOptions: nodemailer.SendMailOptions = {
        from: config.SMTP_FROM,
        to: config.SMTP_TO,
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
