const util = require('util');
const path = require("path");
const mysql = require('mysql');
const fs = require('fs');
const { spawn } = require('child_process');

const { createDatabaseBackup } = require('./backup');
const { runComposer } = require('./runComposer');

async function runDatabaseMigrations(selected_deployment, skipBackup) {
    let hasFailed = false;
    let migrationLog = '';
    console.log('[MIGRATE] Ensuring composer dependencies are up to date...');
    migrationLog += '\n[MIGRATE] Ensuring composer dependencies are up to date...';

    const [hasComposerFailed, composerLog] = await runComposer(selected_deployment);
    migrationLog += composerLog;
    if (hasComposerFailed) {
        console.error('[MIGRATE] Error running composer install');
        migrationLog += '\n[MIGRATE] Error running composer install';
        hasFailed = true;
    }
    if (hasFailed) { return [hasFailed, migrationLog]; }

    console.log('[MIGRATE] Running database migrations...')

    /**
     * The general structure of the updates folder is as follows:
     * updates/
     *     [release]/
     *         [order]-[branch-name]/
     *             [order]-[name].php
     *             [order]-[comp/main]-[name].sql
     *             ...
    */
    const updatesDir = path.join(selected_deployment.path, selected_deployment.migration_folder);

    const allMigrations = {};

    const releases = fs.readdirSync(updatesDir);
    for (const release of releases) {
        // If the "release" is not of the format [year].[major].[minor], then skip it
        if (release.split(".").map(isNaN).filter(r => r === false).length !== 3) {
            continue;
        }

        allMigrations[release] = [];
        const releasePath = path.join(updatesDir, release);
        const migrations = fs.readdirSync(releasePath);
        for (const migration of migrations) {
            const migrationPath = path.join(releasePath, migration);
            const stat = fs.statSync(migrationPath);
            if (stat.isDirectory()) {
                const migrationFiles = fs.readdirSync(migrationPath);
                const migrationFilesFiltered = migrationFiles.filter(filename => {
                    if (filename.endsWith('.sql')) {
                        // Must be of the format [order]-[comp/main]-[name].sql
                        if (!/^\d{2}-(comp|main)-/.test(filename)) {
                            console.warn(`[MIGRATE] WARNING: Skipping migration file ${migration}/${filename}: invalid file name`);
                            migrationLog += `\n[MIGRATE] WARNING: Skipping migration file ${migration}/${filename}: invalid file name`;
                            return false;
                        }
                        return true;
                    }

                    if (filename.endsWith('.php')) {
                        // Must be of the format [order]-[name].php
                        if (!/^\d{2}-/.test(filename)) {
                            console.warn(`[MIGRATE] WARNING: Skipping migration file ${migration}/${filename}: invalid file name`);
                            migrationLog += `\n[MIGRATE] WARNING: Skipping migration file ${migration}/${filename}: invalid file name`;
                            return false;
                        }
                        return true;
                    }

                    return false;
                });

                const migrationFilesSorted = migrationFilesFiltered.sort((a, b) => {
                    const aOrder = parseInt(a.split('-')[0], 10);
                    const bOrder = parseInt(b.split('-')[0], 10);
                    return aOrder - bOrder;
                });

                if (migrationFilesSorted.length === 0) {
                    console.warn(`[MIGRATE] WARNING: Skipping migration ${migration} because no SQL or PHP files were found`);
                    migrationLog += `\n[MIGRATE] WARNING: Skipping migration ${migration} because no SQL or PHP files were found`;
                    continue;
                }

                // A migration name follows the format [order]-[branch-name]
                const migrationOrder = parseInt(migration.split('-')[0], 10);
                const migrationBranch = migration.split('-').slice(1).join('-');

                if (isNaN(migrationOrder)) {
                    console.warn(`[MIGRATE] WARNING: Skipping migration ${migration} because the order is not a number`);
                    migrationLog += `\n[MIGRATE] WARNING: Skipping migration ${migration} because the order is not a number`;
                    continue;
                }

                if (migrationBranch === '') {
                    console.warn(`[MIGRATE] WARNING: Skipping migration ${migration} because the branch name is empty`);
                    migrationLog += `\n[MIGRATE] WARNING: Skipping migration ${migration} because the branch name is empty`;
                    continue;
                }

                allMigrations[release].push({
                    order: migrationOrder,
                    name: migrationBranch,
                    path: migration,
                    files: migrationFilesSorted,
                });
            }
        }

        // Sort the migrations
        allMigrations[release].sort((a, b) => a.order - b.order);
    }

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

    // Migrations are stored in the database as [release]/[branch-name]
    // - Notably, this excludes the [order] part so migrations can be resequenced within a release and not be considered new
    // - However, a migration moved to a different release WILL be considered as new
    const ranMigrationsNames = ranMigrations.map(row => row.update_name);

    const newMigrations = {};
    for (const release in allMigrations) {
        for (const migration of allMigrations[release]) {
            // For legacy reasons (previously migrations were stored in a single directory), we need to check the
            //  old format in case we are updating a deployment previously running a version < 24.1.0
            if (ranMigrationsNames.includes(migration.name)) {
                console.log(`[MIGRATE] Found legacy migration: ${migration.name} - Updating to ${release}/${migration.name}`);
                migrationLog += `\n[MIGRATE] Found legacy migration: ${migration.name} - Updating to ${release}/${migration.name}`;

                // Update the database to the new format
                await queryMain("UPDATE updates SET update_name = ? WHERE update_name = ?", [`${release}/${migration.name}`, migration.name]).catch((err) => {
                    console.error('[MIGRATE] Error updating legacy migration:', err.message);
                    migrationLog += '\n[MIGRATE] Error updating legacy migration: ' + err.message;
                    hasFailed = true;
                });
            }

            // Otherwise, check if the migration is new
            if (!ranMigrationsNames.includes(`${release}/${migration.name}`)) {
                if (!newMigrations[release]) {
                    newMigrations[release] = [];
                }
                newMigrations[release].push(migration);
            }
        }
    };

    if (hasFailed) return [hasFailed, migrationLog];

    if (Object.keys(newMigrations).length === 0) {
        console.log('[MIGRATE] No new migrations to run');
        migrationLog += '\n[MIGRATE] No new migrations to run';
        connectionMain.end();
        return [hasFailed, migrationLog];
    }

    for (const release in newMigrations) {
        console.log(`[MIGRATE] Found ${allMigrations[release].length} new migrations for release ${release}`);
        migrationLog += `\n[MIGRATE] Found ${allMigrations[release].length} new migrations for release ${release}`;

        for (const migration of newMigrations[release]) {
            console.log(`   - ${migration.name} with ${migration.files.length} script${migration.files.length === 1 ? '' : 's'}`);
            migrationLog += `\n   - ${migration.name} with ${migration.files.length} script${migration.files.length === 1 ? '' : 's'}`;
        }
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

    // Run the migrations
    for (const release in newMigrations) {
        if (hasFailed) { break; }

        console.log(`[MIGRATE] Running migrations for ${release} ...`);
        migrationLog += `\n[MIGRATE] Running migrations for ${release}...`;

        // Iterate through the migrations for the current release, and run them
        for (const migration of newMigrations[release]) {
            if (hasFailed) { break; }

            for (const migrationFile of migration.files) {
                if (hasFailed) { break; }
                const migrationFilePath = path.join(updatesDir, release, migration.path, migrationFile);

                if (migrationFile.endsWith(".sql")) {
                    // Run the SQL migration file

                    const filenameParts = migrationFile.split('-');
                    const isMainMigration = filenameParts[1] === 'main';
                    const isCompMigration = filenameParts[1] === 'comp';

                    // console.log(`[MIGRATE] Running migration (SQL) ${migration.path}/${migrationFile}...`);
                    // migrationLog += `\n[MIGRATE] Running migration (SQL) ${migration.path}/${migrationFile}...`;

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
                                    console.log(`[MIGRATE] SQL Migration ${release}/${migration.path}/${migrationFile} complete on ${database_name}\n`);
                                    migrationLog += `\n[MIGRATE] SQL Migration ${release}/${migration.path}/${migrationFile} complete on ${database_name}\n`;
                                    resolve();
                                } else {
                                    console.error(`[MIGRATE] Error running SQL migration ${release}/${migration.path}/${migrationFile} on ${database_name}\n`);
                                    migrationLog += `\n[MIGRATE] Error running SQL migration ${release}/${migration.path}/${migrationFile} on ${database_name}\n`;
                                    reject(code);
                                }
                            });

                            migrateCmd.on('error', (err) => {
                                console.error(`[MIGRATE] Error running SQL migration ${release}/${migration.path}/${migrationFile} on ${database_name}\n`);
                                migrationLog += `\n[MIGRATE] Error running SQL migration ${release}/${migration.path}/${migrationFile} on ${database_name}\n`;
                                reject(err);
                            });

                            migrateCmd.stdout.on('data', (data) => {
                                console.log(data.toString());
                                migrationLog += data;
                            });

                            migrateCmd.stderr.on('data', (data) => {
                                console.log(data.toString());
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
                        // Retrieve the list of comp databases
                        const compDatabases = await queryMain(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '${selected_deployment.database_prefix}_comp_%'`);

                        for (const compDb of compDatabases) {
                            const dbName = compDb.SCHEMA_NAME;

                            await runSQLMigration(dbName).catch((err) => {
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
                                    console.log(`[MIGRATE] PHP Migration ${release}/${migration.path}/${migrationFile} complete\n`);
                                    migrationLog += `\n[MIGRATE] PHP Migration ${release}/${migration.path}/${migrationFile} complete\n`;
                                    resolve();
                                } else {
                                    console.error(`[MIGRATE] Error running PHP migration ${release}/${migration.path}/${migrationFile}\n`);
                                    migrationLog += `\n[MIGRATE] Error running PHP migration ${release}/${migration.path}/${migrationFile}\n`;
                                    reject(code);
                                }
                            });

                            migrateCmd.on('error', (err) => {
                                console.error(`[MIGRATE] Error running PHP migration ${release}/${migration.path}/${migrationFile}\n`);
                                migrationLog += `\n[MIGRATE] Error running PHP migration ${release}/${migration.path}/${migrationFile}\n`;
                                reject(err);
                            });

                            migrateCmd.stdout.on('data', (data) => {
                                console.log(data.toString());
                                migrationLog += data;
                            });

                            migrateCmd.stderr.on('data', (data) => {
                                console.log(data.toString());
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
                    console.log(`[MIGRATE] Migration failed for ${release}/${migration.path}`);
                    migrationLog += `\n[MIGRATE] Migration failed for ${release}/${migration.path}`;
                    connectionMain.end();
                    return [hasFailed, migrationLog];
                }
            }

            // Store the migration as having been run in the main database
            await queryMain(
                'INSERT INTO updates (update_name) VALUES (?)',
                [`${release}/${migration.name}`]
            ).catch((err) => {
                console.error('[MIGRATE] Error storing migration in main database:', err.message);
                migrationLog += '\n[MIGRATE] Error storing migration in main database: ' + err.message;
                hasFailed = true;
                connectionMain.end();
            });
        }
    }

    // Close the connection to the main database
    connectionMain.end();

    return [hasFailed, migrationLog];
}

module.exports = {
    runDatabaseMigrations
};
