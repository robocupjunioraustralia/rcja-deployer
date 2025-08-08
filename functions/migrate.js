const util = require('util');
const path = require("path");
const mysql = require('mysql');
const os = require('os');
const fs = require('fs');
const fse = require('fs-extra');
const { spawn } = require('child_process');

const { createDatabaseBackup } = require('./backup');
const { runComposer } = require('./runComposer');

/**
 * Find what version the deployment is currently on (it's stored in package.json, or null if unknown)
 * It's stored in the "version" field of the package.json file
 * If the package.json file doesn't exist, or the version field is missing,
 *   then the version is less than 23.8.0 (the first version to include the version field)
 * @param {string} deploymentPath The path to the deployment
 * @returns {string|null} The version of the deployment, or null if unknown
 */
function getDeploymentVersion(deploymentPath) {
    const packageJsonPath = path.join(deploymentPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return null;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version || null;
}

/**
 * Find the list of git tags that are available for the deployment
 * This represents the list of releases that can be switched to when running migrations
 * @param {string} deploymentPath The path to the deployment
 * @returns {Promise<string[]>} The list of git tags available for the deployment
 */
async function getDeploymentTags(deploymentPath) {
    return new Promise((resolve, reject) => {
        const git = spawn('git', ['tag'], {
            cwd: deploymentPath,
            shell: true
        });

        let tags = '';
        git.stdout.on('data', (data) => {
            tags += data.toString();
        });

        git.stderr.on('data', (data) => {
            console.error(data.toString());
        });

        git.on('exit', (code) => {
            if (code === 0) {
                resolve(tags.split('\n').filter(tag => tag !== ''));
            } else {
                reject();
            }
        });

        git.on('error', (err) => {
            console.error(err);
            reject(err);
        });
    });
}

/**
 * Check if the deployment has uncommitted changes
 * @param {string} deploymentPath The path to the deployment
 * @returns {Promise<boolean>} True if there are uncommitted changes, false otherwise
 */
async function deploymentHasUncommittedChanges(deploymentPath) {
    return new Promise((resolve, reject) => {
        const git = spawn('git', ['status', '--porcelain'], {
            cwd: deploymentPath,
            shell: true
        });

        let status = '';
        git.stdout.on('data', (data) => {
            status += data.toString();
        });

        git.stderr.on('data', (data) => {
            console.error(data.toString());
        });

        git.on('exit', (code) => {
            if (code === 0) {
                resolve(status.trim() !== '');
            } else {
                reject();
            }
        });

        git.on('error', (err) => {
            console.error(err);
            reject(err);
        });
    });
}

/**
 * Get the current git branch of the deployment so we can
 * jump back to wherever we were after running migrations
 * @param {string} deploymentPath The path to the deployment
 * @param {boolean} useHash Whether to use the hash of the commit instead of the branch name (e.g. if the deployment is in a detached state)
 * @returns {Promise<string>} The current branch name of the deployment (or the commit hash if useHash is true)
 */
async function getCurrentBranch(deploymentPath, useHash = false) {
    return new Promise((resolve, reject) => {
        const git = spawn(
            'git',
            useHash ? ['rev-parse', 'HEAD'] : ['rev-parse', '--abbrev-ref', 'HEAD'],
            {
                cwd: deploymentPath,
                shell: true
            }
        );

        let branch = '';
        git.stdout.on('data', (data) => {
            branch += data.toString();
        });

        git.stderr.on('data', (data) => {
            console.error(data.toString());
        });

        git.on('exit', async (code) => {
            if (code === 0) {
                let branchName = branch.trim();

                if (branchName === "HEAD" && !useHash) {
                    branchName = await getCurrentBranch(deploymentPath, true);
                }

                resolve(branchName);
            } else {
                reject();
            }
        });

        git.on('error', (err) => {
            console.error(err);
            reject(err);
        });
    });
}

/**
 * Checkout to a specific tag/branch/hash in the deployment
 * @param {string} deploymentPath The path to the deployment
 * @param {string} target The tag/branch/hash to checkout to
 * @returns {Promise<void>}
 */
async function checkoutDeploymentTo(deploymentPath, target) {
    return new Promise((resolve, reject) => {
        const git = spawn('git', ['checkout', target], {
            cwd: deploymentPath,
            shell: true
        });

        git.stdout.on('data', (data) => {
            console.log(data.toString());
        });

        git.stderr.on('data', (data) => {
            console.error(data.toString());
        });

        git.on('exit', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject();
            }
        });

        git.on('error', (err) => {
            console.error(err);
            reject(err);
        });
    });
}

/**
 * Create a temporary directory with a copy of all migration files in the updates folder
 * so we can run them even after switching to a different tag
 * @param {string} migrationPath The folder where the migration files are stored
 * @returns {string} The path to the temporary directory
 */
function createMigrationTempDir(migrationPath) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcja-deployer-updates-'));
    fse.copySync(migrationPath, tempDir);
    return tempDir;
}

/**
 * Check if the version of the deployment is compatible with this version of the deployer
 * The current minimum version is 24.4.0 due to changes in the migration structure
 * @param {[number, number, number]} minVersion The minimum version required for compatibility
 * @param {string|null} deploymentVersion The version of the deployment (e.g. "24.4.0"), or null if unknown
 * @returns {boolean} True if the deployment version is compatible, false otherwise
 */
function isDeploymentVersionCompatible(minVersion, deploymentVersion) {
    if (deploymentVersion === null) return false;

    const versionParts = deploymentVersion.split('.').map(part => parseInt(part, 10));

    const majorVersion = versionParts[0];
    const minorVersion = versionParts[1];
    const patchVersion = versionParts[2];

    if (majorVersion < minVersion[0]) return false;

    if (majorVersion === minVersion[0]) {
        if (minorVersion < minVersion[1]) return false;
        if (minorVersion === minVersion[1] && patchVersion < minVersion[2]) return false;
    }

    return true;
}


async function runDatabaseMigrations(selected_deployment, skipBackup, no_composer_dev) {
    let hasFailed = false;
    let migrationLog = '';
    console.log('[MIGRATE] Ensuring composer dependencies are up to date...');
    migrationLog += '\n[MIGRATE] Ensuring composer dependencies are up to date...';

    const [hasComposerFailed, composerLog] = await runComposer(selected_deployment, no_composer_dev);
    migrationLog += composerLog;
    if (hasComposerFailed) {
        console.error('[MIGRATE] Error running composer install');
        migrationLog += '\n[MIGRATE] Error running composer install';
        hasFailed = true;
    }
    if (hasFailed) { return [hasFailed, migrationLog]; }

    console.log('[MIGRATE] Running database migrations...')

    const deploymentVersion = getDeploymentVersion(selected_deployment.path);
    const deploymentTags = await getDeploymentTags(selected_deployment.path);

    // Check if the deployment version is compatible with this version of the deployer
    const minVersion = [24, 4, 0];
    if (isDeploymentVersionCompatible(minVersion, deploymentVersion) === false) {
        const failMessage = `[MIGRATE] Your deployment is not compatible with this version of the deployer`
            + `\n   - Deployment version: ${deploymentVersion || 'Unknown'}`
            + `\n   - Minimum version: ${minVersion.join('.')}`
            + `\n   - Please update the deployment to a compatible version or use an older version of the deployer before proceeding`;

        console.error(failMessage);
        migrationLog += `\n${failMessage}`;
        return [true, migrationLog];
    }

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

        // If the "release" isn't in the list of tags, and it's not the current version, then skip it
        if (!deploymentTags.includes(release) && release !== deploymentVersion) {
            console.log(`[MIGRATE] WARNING: Skipping release ${release} because it does not match any tag or the current version`);
            migrationLog += `\n[MIGRATE] WARNING: Skipping release ${release} because it does not match any tag or the current version`;
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

                // If a "SKIP_MIGRATION" file exists in the migration directory, then skip it entirely
                if (migrationFiles.includes('SKIP_MIGRATION')) { continue; }

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

    /**
     * If there exists migrations that are not for the current release,
     * and there are uncommitted changes in the deployment directory,
     * then we should not proceed with the migration - as it may result in data loss when we switch tags
     */
    const migrationsOutsideCurrentRelease = Object.keys(newMigrations).filter(release => release !== deploymentVersion);
    if (
        migrationsOutsideCurrentRelease.length > 0
        && await deploymentHasUncommittedChanges(selected_deployment.path)
    ) {
        const failMessage = `[MIGRATE] Unable to proceed: Uncommitted changes in deployment directory and migrations outside current release`
            + `\n   - You are currently on: ${deploymentVersion}`
            + `\n   - New migrations found for: ${migrationsOutsideCurrentRelease.join(', ')}`
            + `\n   To avoid data loss, please commit or stash your changes before proceeding`;

        console.error(failMessage);
        migrationLog += `\n${failMessage}`
        connectionMain.end();
        return [true, migrationLog];
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

    // Drop all views before running migrations
    console.log('[MIGRATE] Dropping views...');
    migrationLog += '\n[MIGRATE] Dropping views...';

    const compDatabasesV = await queryMain(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '${selected_deployment.database_prefix}_comp_%'`);
    const databasesToDropViews = [`${selected_deployment.database_prefix}_main`, ...compDatabasesV.map(db => db.SCHEMA_NAME)];

    for (const database of databasesToDropViews) {
        const dropViewsQuery = 'SELECT CONCAT("DROP VIEW ", TABLE_SCHEMA, ".", TABLE_NAME, ";") AS query FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?';
        const dropViews = await queryMain(dropViewsQuery, [database]);
        for (const view of dropViews) {
            await queryMain(view.query);
        }
    }

    console.log('[MIGRATE] Views dropped, proceeding with migrations...');
    migrationLog += '\n[MIGRATE] Views dropped, proceeding with migrations...';

    // Run the migrations
    const initialBranch = await getCurrentBranch(selected_deployment.path);
    let currentReleaseTag = deploymentVersion;
    let tempUpdatesDirPath = null; // used if we need to switch tags, so we can still run the original migrations
    console.log(`[MIGRATE] Deployment is currently on release ${currentReleaseTag} (at ${initialBranch})`);
    migrationLog += `\n[MIGRATE] Deployment is currently on release ${currentReleaseTag} (at ${initialBranch})`;

    for (const release in newMigrations) {
        if (hasFailed) { break; }

        console.log(`[MIGRATE] Running migrations for ${release} ...`);
        migrationLog += `\n[MIGRATE] Running migrations for ${release}...`;

        // Determine if we need to switch to a different tag
        if (release !== currentReleaseTag) {
            // If we are targetting the initial deployment version, then we should switch back to the initial branch
            // and not the deployment version tag (as it may not exist)
            targetToCheckout = release === deploymentVersion ? initialBranch : release;

            console.log(`[MIGRATE] Checking out ${targetToCheckout}...`);
            migrationLog += `\n[MIGRATE] Checking out ${targetToCheckout}...`;

            // If we haven't already created a temporary directory with the migration files, do so now
            if (tempUpdatesDirPath === null) {
                tempUpdatesDirPath = createMigrationTempDir(updatesDir);
                console.log(`[MIGRATE] Created temporary directory with migration files: ${tempUpdatesDirPath}`);
                migrationLog += `\n[MIGRATE] Created temporary directory with migration files: ${tempUpdatesDirPath}`;
            }

            await checkoutDeploymentTo(selected_deployment.path, targetToCheckout).catch((err) => {
                console.error('[MIGRATE] Error switching to tag:', err.message);
                migrationLog += '\n[MIGRATE] Error switching to tag: ' + err.message;
                hasFailed = true;
            });
            if (hasFailed) { break; }

            currentReleaseTag = release;
            console.log(`[MIGRATE] Deployment is now on ${targetToCheckout}`);
            migrationLog += `\n[MIGRATE] Deployment is now on ${targetToCheckout}`;
        }

        const currentUpdatesDir = tempUpdatesDirPath ? tempUpdatesDirPath : updatesDir;

        // Iterate through the migrations for the current release, and run them
        for (const migration of newMigrations[release]) {
            if (hasFailed) { break; }

            for (const migrationFile of migration.files) {
                if (hasFailed) { break; }
                const migrationFilePath = path.join(currentUpdatesDir, release, migration.path, migrationFile);

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
                            ], { shell: true });

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
                                cwd: selected_deployment.path,
                                shell: true
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

    // Switch back to the initial branch, if we switched
    if (currentReleaseTag !== deploymentVersion) {
        console.log(`[MIGRATE] Switching back to branch ${initialBranch}...`);
        migrationLog += `\n[MIGRATE] Switching back to branch ${initialBranch}...`;

        await checkoutDeploymentTo(selected_deployment.path, initialBranch).catch((err) => {
            console.error('[MIGRATE] Error switching back to branch:', err.message);
            migrationLog += '\n[MIGRATE] Error switching back to branch: ' + err.message;
            hasFailed = true;
        });
        if (hasFailed) { return [hasFailed, migrationLog]; }

        console.log(`[MIGRATE] Deployment is now back on branch ${initialBranch}`);
        migrationLog += `\n[MIGRATE] Deployment is now back on branch ${initialBranch}`;
    }

    // Clean up the temporary directory if it was created
    if (tempUpdatesDirPath) {
        fse.removeSync(tempUpdatesDirPath);
        console.log(`[MIGRATE] Removed temporary directory with migration files: ${tempUpdatesDirPath}`);
        migrationLog += `\n[MIGRATE] Removed temporary directory with migration files: ${tempUpdatesDirPath}`;
    }

    // Close the connection to the main database
    connectionMain.end();

    return [hasFailed, migrationLog];
}

module.exports = {
    runDatabaseMigrations
};
