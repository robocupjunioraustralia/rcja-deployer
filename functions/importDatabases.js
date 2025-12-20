const mariadb = require('mariadb');
const fs = require('fs');
const { spawn } = require('child_process');

const { rebuildViews } = require('./rebuildViews');
const { rebuildUsers } = require('./rebuildUsers');
const { rebuildForeignKeys } = require('./rebuildForeignKeys');
const { runDatabaseMigrations } = require('./migrate');
const { enableMaintenance, disableMaintenance } = require('./maintenance');
const { writeLog } = require('./logging');

/**
 * Import databases from SQL dump files
 * CAUTION: This will delete all existing databases for the deployment
 * The dump files should contain the CREATE DATABASE statements for each database that needs to be imported
 * @param {object} deployment - deployment config
 * @param {string[]} filePathsMain - path(s) to the main database dump file(s)
 * @param {string[]} filePathsComp - path(s) to the comp databases dump file(s), should match the main dump so that migrations work correctly
 * @returns {Promise<[boolean, string]>} - [importFailed, importLog]
 */
async function importDatabases(deployment, filePathsMain, filePathsComp) {
    let importLog = "";
    let importFailed = false;
    try {
        const databasePrefix = deployment.database_prefix;

        // Connect to the MariaDB server using the login details
        const pool = mariadb.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        });
        const conn = await pool.getConnection();
        console.log("[IMPORT] Connected to MariaDB server")
        importLog += "\n[IMPORT] Connected to MariaDB server"

        // Retrieve the list of databases attached to the MariaDB server
        const result = await conn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA');
        console.log("[IMPORT] Found " + result.length + " databases on the server")
        importLog += "\n[IMPORT] Found " + result.length + " databases on the server"

        // Before importing, we must delete all of the existing databases if they exist
        // The main db must be deleted last, as it has foreign key links with the comp dbs
        for (const row of result) {
            const dbName = row.SCHEMA_NAME;
            const isComp = dbName.startsWith(`${databasePrefix}_comp_`);
            if (isComp) {
                const compId = dbName.replace(databasePrefix + '_comp_', '');

                // await conn.query("SET FOREIGN_KEY_CHECKS = 0");
                const dropResult = await conn.query(`DROP DATABASE IF EXISTS ${dbName}`);
                const dropRemainingResult = await conn.query(`SHOW DATABASES LIKE '${dbName}'`);

                await conn.query(`DROP USER IF EXISTS '${databasePrefix + '_' + compId + '_lp'}'@'localhost'`);
                await conn.query(`DROP USER IF EXISTS '${databasePrefix + '_' + compId + '_hp'}'@'localhost'`);

                // await conn.query("SET FOREIGN_KEY_CHECKS = 1");
                console.log(`[IMPORT] Dropped database ${dbName}: ${dropResult.warningStatus} warnings, ${dropResult.affectedRows} rows affected, ${dropRemainingResult.length} remaining`)
                importLog += `\n[IMPORT] Dropped database ${dbName}: ${dropResult.warningStatus} warnings, ${dropResult.affectedRows} rows affected, ${dropRemainingResult.length} remaining`
            }
        }

        // await conn.query("SET FOREIGN_KEY_CHECKS = 0");
        const dropMainResult = await conn.query(`DROP DATABASE IF EXISTS ${databasePrefix}_main`);
        const dropMainRemainingResult = await conn.query(`SHOW DATABASES LIKE '${databasePrefix}_main'`);
        // await conn.query("SET FOREIGN_KEY_CHECKS = 1");
        console.log(`[IMPORT] Dropped database ${databasePrefix}_main: ${dropMainResult.warningStatus} warnings, ${dropMainResult.affectedRows} rows affected, ${dropMainRemainingResult.length} remaining`)
        importLog += `\n[IMPORT] Dropped database ${databasePrefix}_main: ${dropMainResult.warningStatus} warnings, ${dropMainResult.affectedRows} rows affected, ${dropMainRemainingResult.length} remaining`

        async function runSQLFile(filePath) {
            return new Promise((resolve, reject) => {
                const migrateCmd = spawn(process.env.MYSQL_PATH, [
                    `-u${process.env.DB_USER}`,
                    `-p${process.env.DB_PASSWORD}`
                ], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                const inputStream = fs.createReadStream(filePath);
                inputStream.pipe(migrateCmd.stdin);

                inputStream.on('error', (err) => {
                    console.error(`[IMPORT] Error reading ${filePath}: ${err.message}\n`);
                    importLog += `\n[IMPORT] Error reading ${filePath}: ${err.message}\n`;
                    reject(err);
                });

                migrateCmd.on('exit', (code) => {
                    if (code === 0) {
                        console.log(`[IMPORT] Successfully imported ${filePath}\n`);
                        importLog += `\n[IMPORT] Successfully imported ${filePath}\n`;
                        resolve();
                    } else {
                        console.error(`[IMPORT] Error importing ${filePath}\n`);
                        importLog += `\n[IMPORT] Error importing ${filePath}\n`;
                        reject(code);
                    }
                });

                migrateCmd.on('error', (err) => {
                    console.error(`[IMPORT] Error importing ${filePath}\n`);
                    importLog += `\n[IMPORT] Error importing ${filePath}\n`;
                    reject(err);
                });

                migrateCmd.stdout.on('data', (data) => {
                    console.log(data.toString());
                    importLog += data;
                });

                migrateCmd.stderr.on('data', (data) => {
                    console.log(data.toString());
                    importLog += data;
                });
            });
        }

        // Must import the main DB first, as the comp DBs have foreign key links to it
        for (const filePath of [...filePathsMain, ...filePathsComp]) {
            console.log(`[IMPORT] Importing ${filePath}`);
            importLog += `\n[IMPORT] Importing ${filePath}`;
            await runSQLFile(filePath);
        }

        console.log("[IMPORT] Finished importing databases")
        importLog += "\n[IMPORT] Finished importing databases"

        // Disconnect from the MariaDB server
        conn.release();
        await pool.end();
    } catch (err) {
        console.error(err);
        importFailed = true;
        importLog += "\n[IMPORT] Failed to sync databases"
        importLog += "\n[IMPORT] Error: " + err
    }

    return [importFailed, importLog]
}

async function runImportDatabases(deployment, filePathsMain, filePathsComp) {
    console.log(`[IMPORT] IMPORTING DATABASES TO ${deployment.title}`);
    let importLog = `--- IMPORTING DATABASES TO ${deployment.title} ---`;

    enableMaintenance(deployment);
    importLog += `\n[IMPORT] Started on ${new Date().toISOString()}\n\n`;

    const [importFailed, newImportLog] = await importDatabases(deployment, filePathsMain, filePathsComp);
    importLog += newImportLog;
    importLog += `\n\n--- IMPORT: ${importFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (importFailed) {
      writeLog(importLog, false, "import");
      console.log("[IMPORT] Import failed");
      return [importFailed, importLog];
    }

    console.log('[IMPORT] Recreating database users...')
    importLog += "\n--- RECREATING DATABASE UESRS ---\n";
    const [rebuildUsersFailed, rebuildUsersLog] = await rebuildUsers(deployment);
    importLog += rebuildUsersLog;
    importLog += `\n\n--- REBUILD UESRS: ${rebuildUsersFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (rebuildUsersFailed) {
      writeLog(importLog, false, "import");
      console.error("[IMPORT] Rebuild Users Failed");
      return [rebuildUsersFailed, importLog];
    }

    // Because we have copied from production, some database changes might not have been applied
    // We need to run the migrations again to ensure that the database is up to date
    console.log('[IMPORT] Running database migrations...')
    importLog += "\n--- RUNNING DATABASE MIGRATIONS ---\n";
    const [migrateFailed, migrateLog] = await runDatabaseMigrations(deployment, true, deployment.no_composer_dev || false);
    console.log("[IMPORT] Migration complete: ", migrateFailed ? "FAIL" : "SUCCESS");
    importLog += migrateLog;
    importLog += `\n\n--- DATABASE MIGRATIONS: ${migrateFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (migrateFailed) {
      writeLog(importLog, false, "import");
      console.error("[IMPORT] Migration failed");
      return [migrateFailed, importLog];
    }

    console.log('[IMPORT] Rebuilding foreign keys...')
    importLog += "\n--- REBUILDING FOREIGN KEYS ---\n";
    const [rebuildFKeysFailed, rebuildFKeysLog] = await rebuildForeignKeys(deployment);
    importLog += rebuildFKeysLog;
    importLog += `\n\n--- REBUILDING FOREIGN KEYS: ${rebuildFKeysFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (rebuildFKeysFailed) {
      writeLog(importLog, false, "import");
      console.error("[IMPORT] Rebuild Foreign Keys failed");
      return [rebuildFKeysFailed, importLog];
    }

    // Rebuild the views
    console.log('[IMPORT] Rebuilding views...')
    importLog += "\n--- REBUILDING VIEWS ---\n";
    const [rebuildFailed, rebuildLog] = await rebuildViews(deployment);
    console.log("[IMPORT] View rebuild complete: ", rebuildFailed ? "FAIL" : "SUCCESS");
    importLog += rebuildLog;
    importLog += `\n\n--- REBUILDING VIEWS: ${rebuildFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (rebuildFailed) {
      writeLog(importLog, false, "import");
      console.error("[IMPORT] View rebuild failed");
      return [rebuildFailed, importLog];
    }

    importLog += `\n[IMPORT] Finished on ${new Date().toISOString()}\n\n`
    writeLog(importLog, true, "import");
    console.log("[IMPORT] Import complete")
    disableMaintenance(deployment);

    return [false, importLog];
}

module.exports = {
    runImportDatabases
};
