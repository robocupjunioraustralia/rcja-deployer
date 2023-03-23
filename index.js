const { exec } = require('child_process');
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require("morgan");
const dotenv = require("dotenv");
const util = require('util');
const path = require("path");
const mysql = require('mysql');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');
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
  
  enableMaintenance();
  deployLog = `Deployment started on ${new Date().toISOString()}\n\n`;
  // Execute the shell script to pull the latest changes from the master branch
  exec(`cd ${process.env.PATH_TO_RCJCMS} && git fetch && git status && git pull origin master`, async (err, stdout, stderr) => {
    if (err) {
      console.error(err);
      deployLog += `--- Error while pulling changes ---\n${err}\n${stderr}\n`;
      writeLog(deployLog, false);
      return res.status(500).send('Error executing shell script');
    }
    deployLog += `--- Successfully pulled all changes ---\n${stdout}\n${stderr}\n`;
    
    // Check for any database migrations
    console.log('[MIGRATE] Running database migrations...')
    deployLog += "\n--- RUNNING DATABASE MIGRATIONS ---\n";
    const [migrateFailed, migrateLog] = await runDatabaseMigrations("rcj_cms");
    console.log("[DEPLOY] Migration complete");
    deployLog += migrateLog;
    deployLog += `\n\n--- DATABASE MIGRATIONS: ${migrateFailed ? "FAIL" : "SUCCESS"} --- \n\n`;
  
    if (migrateFailed) {
      writeLog(deployLog, false);
      return res.status(500).send('Error executing database migrations');
    }
      
    writeLog(deployLog, true);
    res.status(200).send('OK');
    disableMaintenance();
  });
});

async function createDatabaseBackup(prefix) {
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

  const backupFolder = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupFolder)) {
    fs.mkdirSync(backupFolder);
  }

  const backupDir = path.join(__dirname, `backups/${prefix}_${formattedDate}`);
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
  const mainDbBackupName = `backup_${prefix}_main.sql`;
  const mainDbBackupFile = path.join(backupDir, mainDbBackupName);
  const mainDbWstream = fs.createWriteStream(mainDbBackupFile);
  
  await createMySQLDump(`${prefix}_main`, mainDbWstream).catch((err) => {
    console.error(`[BACKUP] Error creating database backup for ${prefix}_main`);
    backupLog += `\n[BACKUP] Error creating database backup for ${prefix}_main`;
    hasFailed = true;
  });
  if (hasFailed) { return [hasFailed, backupLog]; }

  // Backup comp databases
  const connectionMain = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: `${prefix}_main`,
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
  console.log(`[BACKUP] Successfully connected to database ${prefix}_main`);
  backupLog += `\n[BACKUP] Successfully connected to database ${prefix}_main`;

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

    const dbName = `${prefix}_comp_${uid}`;
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

async function runDatabaseMigrations(prefix) {
  let hasFailed = false;
  let migrationLog = '';
  console.log('[MIGRATE] Running database migrations...')

  const updatesDir = path.join(process.env.PATH_TO_RCJCMS, 'updates');

  // Get a list of migration directories in the updates folder
  const migrationDirs = fs.readdirSync(updatesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  const connectionMain = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: `${prefix}_main`,
  });

  const connectMain = util.promisify(connectionMain.connect.bind(connectionMain));
  const queryMain = util.promisify(connectionMain.query.bind(connectionMain));

  // Connect to the main database
  await connectMain().catch((err) => {
    console.error('[MIGRATE] Error connecting to database:', err.message);
    migrationLog += '\n[MIGRATE] Error connecting to database: ' + err.message;
    hasFailed = true;
    connectionMain.end();
  });
  if (hasFailed) { return [hasFailed, migrationLog]; }
  console.log(`[MIGRATE] Successfully connected to database ${prefix}_main`);
  migrationLog += `\n[MIGRATE] Successfully connected to database ${prefix}_main`;

  // Read the updates table to get a list of migrations that have already been run
  const ranMigrations = await queryMain('SELECT update_name FROM updates').catch((err) => {
    console.error('[MIGRATE] Error reading updates table:', err.message);
    migrationLog += '\n[MIGRATE] Error reading updates table: ' + err.message;
    hasFailed = true;
    connectionMain.end();
  });
  if (hasFailed) { return [hasFailed, migrationLog]; }

  const ranMigrationsNames = ranMigrations.map(row => row.update_name);
  const newMigrations = [];

  // For each migration directory, check if it has already been run
  migrationDirs.forEach((migrationDir) => {
    if (!ranMigrationsNames.includes(migrationDir)) {
      console.log(`[MIGRATE] New migration found: ${migrationDir}`);
      migrationLog += `\n[MIGRATE] New migration found: ${migrationDir}`;
      newMigrations.push(migrationDir);
    }
  });

  if (newMigrations.length === 0) {
    console.log('[MIGRATE] No new migrations to run');
    migrationLog += '\n[MIGRATE] No new migrations to run';
    connectionMain.end();
    return [hasFailed, migrationLog];
  }

  // Create a full backup before proceeding with any migration
  const [hasBackupFailed, backupLog] = await createDatabaseBackup(prefix);
  migrationLog += backupLog;
  if (hasBackupFailed) {
    console.error('[MIGRATE] Error creating full backup before running migrations');
    migrationLog += '\n[MIGRATE] Error creating full backup before running migrations';
    connectionMain.end();
    return [true, migrationLog];
  }

  // For each new migration, run the SQL files in the directory
  for (const migrationDir of newMigrations) {
    if (hasFailed) { break; }
    const migrationDirPath = path.join(updatesDir, migrationDir);

    // Loop through each migration file in the directory
    const migrationFiles = fs.readdirSync(migrationDirPath)
      .filter(filename => filename.endsWith('.sql') || filename.endsWith('.php'))
      .sort();

    const allFiles = fs.readdirSync(migrationDirPath);

    for (const migrationFile of allFiles) {
      if (hasFailed) { break; }
      if (!migrationFiles.includes(migrationFile)) {
        console.log(`[MIGRATE] WARNING: Skipping file ${migrationDir}/${migrationFile}: unknown file type`);
        migrationLog += `\n[MIGRATE] WARNING: Skipping file ${migrationDir}/${migrationFile}: unknown file type`;
        continue;
      }
      const migrationFilePath = path.join(migrationDirPath, migrationFile);

      if (migrationFile.endsWith(".sql")) {
        // Run the SQL migration file

        // Ensure the migration file follows the expected format
        if (!/^\d{2}-(comp|main)-/.test(migrationFile)) {
          console.warn(`[MIGRATE] WARNING: Skipping migration file ${migrationDir}/${migrationFile} because it does not follow the expected format.`);
          migrationLog += `\n[MIGRATE] WARNING: Skipping migration file ${migrationDir}/${migrationFile} because it does not follow the expected format.`;
          continue;
        }

        const filenameParts = migrationFile.split('-');
        const isMainMigration = filenameParts[1] === 'main';
        const isCompMigration = filenameParts[1] === 'comp';

        // console.log(`[MIGRATE] Running migration (SQL) ${migrationDir}/${migrationFile}...`);
        // migrationLog += `\n[MIGRATE] Running migration (SQL) ${migrationDir}/${migrationFile}...`;

        const runSQLMigration = async (database_name) => {
          return new Promise((resolve, reject) => {                            
            const migrateCmd = spawn(process.env.MYSQL_PATH, [
              '-u',
              process.env.DB_USER,
              '-p' + process.env.DB_PASSWORD,
              database_name,
            ]);

            const migrationScript = fs.readFileSync(migrationFilePath, 'utf8');
            migrateCmd.stdin.write(migrationScript);
            migrateCmd.stdin.end();

            migrateCmd.on('exit', (code) => {
              if (code === 0) {
                console.log(`[MIGRATE] SQL Migration ${migrationDir}/${migrationFile} complete on ${database_name}`);
                migrationLog += `\n[MIGRATE] SQL Migration ${migrationDir}/${migrationFile} complete on ${database_name}`;
                resolve();
              } else {
                console.error(`[MIGRATE] Error running SQL migration ${migrationDir}/${migrationFile} on ${database_name}`);
                migrationLog += `\n[MIGRATE] Error running SQL migration ${migrationDir}/${migrationFile} on ${database_name}`;
                reject(code);
              }
            });

            migrateCmd.on('error', (err) => {
              console.error(`[MIGRATE] Error running SQL migration ${migrationDir}/${migrationFile} on ${database_name}`);
              migrationLog += `\n[MIGRATE] Error running SQL migration ${migrationDir}/${migrationFile} on ${database_name}`;
              reject(err);
            });

            migrateCmd.stdout.on('data', (data) => {
              migrationLog += data;
            });
    
            migrateCmd.stderr.on('data', (data) => {
              migrationLog += data;
            });
          });
        }

        if (isMainMigration) {
          // Run the migration file on the main database
          await runSQLMigration(`${prefix}_main`).catch((err) => {
            console.error('[MIGRATE] Error running main migration:', err?.message || err);
            migrationLog += '\n[MIGRATE] Error running main migration: ' + (err?.message || err);
            hasFailed = true;
          });
        } else if (isCompMigration) {
          // Read the comps table to get a list of all comps
          const allComps = await queryMain('SELECT uid FROM comps').catch((err) => {
            console.error('[MIGRATE] Error reading comps table:', err.message);
            migrationLog += '\n[MIGRATE] Error reading comps table: ' + err.message;
            hasFailed = true;
            connectionMain.end();
          });
          if (hasFailed) { return [hasFailed, migrationLog]; }
          
          // Run the migration file on each comp database
          for (const comp of allComps) {
            await runSQLMigration(`${prefix}_comp_${comp.uid}`).catch((err) => {
              console.error('[MIGRATE] Error running comp migration:', err?.message || err);
              migrationLog += '\n[MIGRATE] Error running comp migration: ' + (err?.message || err);
              hasFailed = true;
            });
          }
        }
      } else if (migrationFile.endsWith(".php")) {
        // Run the PHP migration file
        const runPHPMigration = async () => {
          return new Promise((resolve, reject) => {                            
            const migrateCmd = spawn(process.env.PHP_PATH, [
              migrationFilePath
            ], {
              cwd: process.env.PATH_TO_RCJCMS
            });

            migrateCmd.on('exit', (code) => {
              if (code === 0) {
                console.log(`[MIGRATE] PHP Migration ${migrationDir}/${migrationFile} complete`);
                migrationLog += `\n[MIGRATE] PHP Migration ${migrationDir}/${migrationFile} complete`;
                resolve();
              } else {
                console.error(`[MIGRATE] Error running PHP migration ${migrationDir}/${migrationFile}`);
                migrationLog += `\n[MIGRATE] Error running PHP migration ${migrationDir}/${migrationFile}`;
                reject(code);
              }
            });

            migrateCmd.on('error', (err) => {
              console.error(`[MIGRATE] Error running PHP migration ${migrationDir}/${migrationFile}`);
              migrationLog += `\n[MIGRATE] Error running PHP migration ${migrationDir}/${migrationFile}`;
              reject(err);
            });

            migrateCmd.stdout.on('data', (data) => {
              migrationLog += data;
            });
    
            migrateCmd.stderr.on('data', (data) => {
              migrationLog += data;
            });
          });
        }

        await runPHPMigration().catch((err) => {
          console.error('[MIGRATE] Error running PHP migration:', err?.message || err);
          migrationLog += '\n[MIGRATE] Error running PHP migration: ' + (err?.message || err);
          hasFailed = true;
        });
      }

      if (hasFailed) {
        console.log(`[MIGRATE] Migration failed for ${migrationDir}`);
        migrationLog += `\n[MIGRATE] Migration failed for ${migrationDir}`;
        connectionMain.end();
        return [hasFailed, migrationLog]; 
      }
    }
    // Store the migration as having been run in the main database
    const query = 'INSERT INTO updates (update_name) VALUES (?)';
    
    await queryMain(query, [migrationDir]).catch((err) => {
      console.error('[MIGRATE] Error storing migration in main database:', err.message);
      migrationLog += '\n[MIGRATE] Error storing migration in main database: ' + err.message;
      hasFailed = true;
      connectionMain.end();
    });
  }

  connectionMain.end();

  return [hasFailed, migrationLog];
}
  
function enableMaintenance() {
  const maintenanceFile = path.join(process.env.PATH_TO_RCJCMS, 'MAINTENANCE');
  fs.writeFile(maintenanceFile, 'MAINTENANCE', (err) => {
    if (err) {
      console.error(err);
    } else {
      console.log('[DEPLOYER] Maintenance mode enabled');
    }
  });
}

function disableMaintenance() {
  const maintenanceFile = path.join(process.env.PATH_TO_RCJCMS, 'MAINTENANCE');
  if (fs.existsSync(maintenanceFile)) {
    fs.unlink(maintenanceFile, (err) => {
      if (err) {
        console.error(err);
      } else {
        console.log('[DEPLOYER] Maintenance mode disabled');
      }
    });
  }
}

app.listen(process.env.HTTP_PORT, () => {
  console.log(`Deployer server listening on port ${process.env.HTTP_PORT}`);
});