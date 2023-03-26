const util = require('util');
const path = require("path");
const mysql = require('mysql');
const fs = require('fs');
const { spawn } = require('child_process');

const { createDatabaseBackup } = require('./backup');

async function runDatabaseMigrations(selected_deployment, skipBackup) {
    let hasFailed = false;
    let migrationLog = '';
    console.log('[MIGRATE] Running database migrations...')
    
    const updatesDir = path.join(selected_deployment.path, selected_deployment.migration_folder);
    
    // Get a list of migration directories in the updates folder
    const migrationDirs = fs.readdirSync(updatesDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
    
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
        console.error('[MIGRATE] Error connecting to database:', err.message);
        migrationLog += '\n[MIGRATE] Error connecting to database: ' + err.message;
        hasFailed = true;
        connectionMain.end();
    });
    if (hasFailed) { return [hasFailed, migrationLog]; }
    console.log(`[MIGRATE] Successfully connected to database ${selected_deployment.database_prefix}_main`);
    migrationLog += `\n[MIGRATE] Successfully connected to database ${selected_deployment.database_prefix}_main`;
    
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
    if (!skipBackup) {
        const [hasBackupFailed, backupLog] = await createDatabaseBackup(selected_deployment);
        migrationLog += backupLog;
        if (hasBackupFailed) {
            console.error('[MIGRATE] Error creating full backup before running migrations');
            migrationLog += '\n[MIGRATE] Error creating full backup before running migrations';
            connectionMain.end();
            return [true, migrationLog];
        }
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
                    await runSQLMigration(`${selected_deployment.database_prefix}_main`).catch((err) => {
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
                        await runSQLMigration(`${selected_deployment.database_prefix}_comp_${comp.uid}`).catch((err) => {
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
                            cwd: selected_deployment.path
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

module.exports = {
    runDatabaseMigrations
};