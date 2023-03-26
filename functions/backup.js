const util = require('util');
const path = require("path");
const mysql = require('mysql');
const fs = require('fs');
const { spawn } = require('child_process');

async function createDatabaseBackup(selected_deployment) {
    let hasFailed = false;
    let backupLog = '\n\n[BACKUP] Running database backup...';
    console.log('[BACKUP] Running database backup...')
    
    // Create backup folder with current date
    const currentDate = new Date();
    const day = currentDate.getDate().toString().padStart(2, '0');
    const month = (currentDate.getMonth() + 1).toString().padStart(2, '0');
    const year = currentDate.getFullYear().toString();
    const hours = currentDate.getHours().toString().padStart(2, '0');
    const minutes = currentDate.getMinutes().toString().padStart(2, '0');
    const seconds = currentDate.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedDate = `${day}-${month}-${year}_${hours}-${minutes}-${seconds}-${ampm}`;
    
    const backupFolder = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupFolder)) {
        fs.mkdirSync(backupFolder);
    }
    
    const backupDir = path.join(__dirname, `../backups/${selected_deployment.database_prefix}_${formattedDate}`);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir);
    }
    
    const createMySQLDump = async (database, writeStream) => {
        return new Promise((resolve, reject) => {
            const mysqldump = spawn(process.env.MYSQLDUMP_PATH, [
                '-u',
                process.env.DB_USER,
                '-p' + process.env.DB_PASSWORD,
                database,
            ]);
            mysqldump.stdout.pipe(writeStream);
            mysqldump.on('exit', (code) => {
                if (code === 0) {
                    console.log(`[BACKUP] Backup created for ${database}`);
                    backupLog += `\n[BACKUP] Backup created for ${database}`;
                    resolve();
                } else {
                    console.error(`[BACKUP] Error creating database backup for ${database}`);
                    backupLog += `\n[BACKUP] Error creating database backup for ${database}`;
                    hasFailed = true;
                    reject();
                }
            });
            mysqldump.on('error', (err) => {
                console.error(`[BACKUP] Error creating database backup for ${database}`);
                backupLog += `\n[BACKUP] Error creating database backup for ${database}`;
                hasFailed = true;
                reject(err);
            });
            
            mysqldump.stderr.on('data', (data) => {
                backupLog += data;
            });
        });
    }
    
    // Backup rcj_cms_main database
    const mainDbBackupName = `backup_${selected_deployment.database_prefix}_main.sql`;
    const mainDbBackupFile = path.join(backupDir, mainDbBackupName);
    const mainDbWstream = fs.createWriteStream(mainDbBackupFile);
    
    await createMySQLDump(`${selected_deployment.database_prefix}_main`, mainDbWstream).catch((err) => {
        console.error(`[BACKUP] Error creating database backup for ${selected_deployment.database_prefix}_main`);
        backupLog += `\n[BACKUP] Error creating database backup for ${selected_deployment.database_prefix}_main`;
        hasFailed = true;
    });
    if (hasFailed) { return [hasFailed, backupLog]; }
    
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
    if (hasFailed) { return [hasFailed, backupLog]; }
    console.log(`[BACKUP] Successfully connected to database ${selected_deployment.database_prefix}_main`);
    backupLog += `\n[BACKUP] Successfully connected to database ${selected_deployment.database_prefix}_main`;
    
    // Read the comps table to get a list of all comps
    const allComps = await queryMain('SELECT uid FROM comps').catch((err) => {
        console.error('[BACKUP] Error reading comps table:', err.message);
        backupLog += '\n[BACKUP] Error reading comps table: ' + err.message;
        hasFailed = true;
        connectionMain.end();
    });
    if (hasFailed) { return [hasFailed, backupLog]; }
    
    connectionMain.end();
    
    // For each uid, create a backup of the corresponding database
    for (const comp of allComps) {
        const uid = comp.uid;
        
        const dbName = `${selected_deployment.database_prefix}_comp_${uid}`;
        const backupName = `backup_${dbName}.sql`;
        const backupFile = path.join(backupDir, backupName);
        const wstream = fs.createWriteStream(backupFile);
        
        await createMySQLDump(dbName, wstream).catch((err) => {
            console.error(`[BACKUP] Error creating database backup for ${dbName}`);
            backupLog += `\n[BACKUP] Error creating database backup for ${dbName}`;
            hasFailed = true;
        });
        if (hasFailed) { return [hasFailed, backupLog]; }
    };
    
    console.log('[BACKUP] Database backup complete');
    backupLog += '\n[BACKUP] Database backup complete\n';
    return [hasFailed, backupLog];
}

module.exports = {
    createDatabaseBackup
};