const util = require('util');
const path = require("path");
const mysql = require('mysql');
const fs = require('fs');
const { spawn } = require('child_process');

function getDeploymentBackupDir(selected_deployment, makeIfMissing) {
    const backupFolder = path.join(__dirname, '../backups');
    if (makeIfMissing && !fs.existsSync(backupFolder)) {
        fs.mkdirSync(backupFolder);
    }

    const deploymentBackupFolder = path.join(backupFolder, selected_deployment.database_prefix);
    if (makeIfMissing && !fs.existsSync(deploymentBackupFolder)) {
        fs.mkdirSync(deploymentBackupFolder);
    }

    return deploymentBackupFolder;
}

async function createDatabaseBackup(selected_deployment, join_comps = false) {
    let hasFailed = false;
    let backupLog = '\n\n[BACKUP] Running database backup...';
    console.log('[BACKUP] Running database backup...')

    // Create backup folder with current date
    const backupName = new Date().toISOString().replaceAll(':', '-').split('.')[0];
    const backupDir = path.join(getDeploymentBackupDir(selected_deployment, true), backupName);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir);
    }

    const createMySQLDump = async (databases, label, writeStream) => {
        return new Promise((resolve, reject) => {
            const mysqldump = spawn(process.env.MYSQLDUMP_PATH, [
                '-u',
                process.env.DB_USER,
                '-p' + process.env.DB_PASSWORD,
                '--databases',
                ...databases,
            ], { shell: true });
            mysqldump.stdout.pipe(writeStream);
            mysqldump.on('exit', (code) => {
                if (code === 0) {
                    console.log(`[BACKUP] Backup created for ${label}`);
                    backupLog += `\n[BACKUP] Backup created for ${label}`;
                    resolve();
                } else {
                    console.error(`[BACKUP] Error creating database backup for ${label}: ${code}`);
                    backupLog += `\n[BACKUP] Error creating database backup for ${label}: ${code}`;
                    hasFailed = true;
                    reject();
                }
            });
            mysqldump.on('error', (err) => {
                console.error(`[BACKUP] Error creating database backup for ${label}:`, err);
                backupLog += `\n[BACKUP] Error creating database backup for ${label}: ${err}`;
                hasFailed = true;
                reject(err);
            });

            mysqldump.stderr.on('data', (data) => {
                console.log(data.toString());
                backupLog += data;
            });
        });
    }

    // Backup comp databases
    const connectionMain = mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: `${selected_deployment.database_prefix}_main`,
    });

    const connectMain = util.promisify(connectionMain.connect.bind(connectionMain));
    const queryMain = util.promisify(connectionMain.query.bind(connectionMain));

    // Connect to the main database
    await connectMain().catch((err) => {
        console.error('[BACKUP] Error connecting to database:', err.message);
        backupLog += '\n[BACKUP] Error connecting to database: ' + err.message;
        hasFailed = true;
        connectionMain.end();
    });
    if (hasFailed) { return { hasFailed, backupLog, backupName, backupDir, backupFiles }; }
    console.log(`[BACKUP] Successfully connected to database ${selected_deployment.database_prefix}_main`);
    backupLog += `\n[BACKUP] Successfully connected to database ${selected_deployment.database_prefix}_main`;

    // Read the comps table to get a list of all comps
    const allComps = await queryMain('SELECT uid FROM comps').catch((err) => {
        console.error('[BACKUP] Error reading comps table:', err.message);
        backupLog += '\n[BACKUP] Error reading comps table: ' + err.message;
        hasFailed = true;
        connectionMain.end();
    });
    if (hasFailed) { return { hasFailed, backupLog, backupDir, backupFiles }; }

    connectionMain.end();

    const backupFiles = [];

    // Backup rcj_cms_main database
    const mainDbBackupName = `${selected_deployment.database_prefix}_main.sql`;
    const mainDbBackupFile = path.join(backupDir, mainDbBackupName);
    const mainDbWstream = fs.createWriteStream(mainDbBackupFile);

    backupFiles.push(mainDbBackupFile);

    await createMySQLDump(
        [`${selected_deployment.database_prefix}_main`],
        `${selected_deployment.database_prefix}_main`,
        mainDbWstream
    ).catch((err) => {
        console.error(`[BACKUP] Error creating database backup for ${selected_deployment.database_prefix}_main:`, err);
        backupLog += `\n[BACKUP] Error creating database backup for ${selected_deployment.database_prefix}_main: ${err}`;
        hasFailed = true;
    });
    mainDbWstream.close();
    if (hasFailed) { return { hasFailed, backupLog, backupName, backupDir, backupFiles }; }

    if (join_comps) {
        // Backup all comp databases into a single file
        const compDbsBackupName = `${selected_deployment.database_prefix}_comp.sql`;
        const compDbsBackupFile = path.join(backupDir, compDbsBackupName);
        const compDbsWstream = fs.createWriteStream(compDbsBackupFile);

        backupFiles.push(compDbsBackupFile);

        await createMySQLDump(
            allComps.map(comp => `${selected_deployment.database_prefix}_comp_${comp.uid}`),
            `${selected_deployment.database_prefix}_comp_*`,
            compDbsWstream
        ).catch((err) => {
            console.error(`[BACKUP] Error creating database backup for ${selected_deployment.database_prefix}_comp_*`, err);
            backupLog += `\n[BACKUP] Error creating database backup for ${selected_deployment.database_prefix}_comp_*: ${err}`;
            hasFailed = true;
        });
        compDbsWstream.close();
        if (hasFailed) { return { hasFailed, backupLog, backupName, backupDir, backupFiles }; }
    } else {
        // For each uid, create a backup of the corresponding database
        for (const comp of allComps) {
            const uid = comp.uid;

            const dbName = `${selected_deployment.database_prefix}_comp_${uid}`;
            const backupName = `${dbName}.sql`;
            const backupFile = path.join(backupDir, backupName);
            const wstream = fs.createWriteStream(backupFile);

            backupFiles.push(backupFile);

            await createMySQLDump([dbName], dbName, wstream).catch((err) => {
                console.error(`[BACKUP] Error creating database backup for ${dbName}`, err);
                backupLog += `\n[BACKUP] Error creating database backup for ${dbName}: ${err}`;
                hasFailed = true;
            });
            wstream.close();
            if (hasFailed) { return { hasFailed, backupLog, backupName, backupDir, backupFiles }; }
        };
    }

    console.log('[BACKUP] Database backup complete');
    backupLog += '\n[BACKUP] Database backup complete\n';
    return { hasFailed, backupLog, backupName, backupDir, backupFiles };
}

module.exports = {
    createDatabaseBackup,
    getDeploymentBackupDir,
};
