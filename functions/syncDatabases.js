const mariadb = require('mariadb');

const { rebuildViews } = require('./rebuildViews');
const { rebuildUsers } = require('./rebuildUsers');
const { rebuildForeignKeys } = require('./rebuildForeignKeys');
const { anonymiseDatabase } = require('./anonymiseDatabase');
const { runDatabaseMigrations } = require('./migrate');
const { enableMaintenance, disableMaintenance } = require('./maintenance');
const { writeLog } = require('./logging');

// This function syncronises the databases between the production and staging servers
// All of the databases on the production server will be copied to the staging server
// The staging server will have the same databases, but with a different prefix
async function syncDatabases(fromDeployment, toDeployment) {
    let syncLog = "";
    let syncFailed = false;
    try {
        productionPrefix = fromDeployment.database_prefix;
        stagingPrefix = toDeployment.database_prefix;

        // Connect to the MariaDB server using the login details
        const pool = mariadb.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        });
        const conn = await pool.getConnection();
        console.log("[SYNC] Connected to MariaDB server")
        syncLog += "\n[SYNC] Connected to MariaDB server"

        // Retrieve the list of databases attached to the MariaDB server
        const result = await conn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA');
        console.log("[SYNC] Found " + result.length + " databases on the server")
        syncLog += "\n[SYNC] Found " + result.length + " databases on the server"

        // To ensure a full sync, we must delete all of the staging databases.
        // The main db must be deleted last, as it has foreign key links with the comp dbs
        for (const row of result) {
            const dbName = row.SCHEMA_NAME;
            const isComp = dbName.startsWith(stagingPrefix + '_comp_');
            if (isComp) {
                // await conn.query("SET FOREIGN_KEY_CHECKS = 0");
                const dropResult = await conn.query(`DROP DATABASE IF EXISTS ${dbName}`);
                const dropRemainingResult = await conn.query('SHOW DATABASES LIKE "' + dbName + '"');
                // await conn.query("SET FOREIGN_KEY_CHECKS = 1");
                console.log(`[SYNC] Dropped old database (init) ${dbName}: ${dropResult.warningStatus} warnings, ${dropResult.affectedRows} rows affected, ${dropRemainingResult.length} remaining`)
                syncLog += `\n[SYNC] Dropped old database (init) ${dbName}: ${dropResult.warningStatus} warnings, ${dropResult.affectedRows} rows affected, ${dropRemainingResult.length} remaining`
            }
        }

        // await conn.query("SET FOREIGN_KEY_CHECKS = 0");
        const dropMainResult = await conn.query(`DROP DATABASE IF EXISTS ${stagingPrefix}_main`);
        const dropMainRemainingResult = await conn.query('SHOW DATABASES LIKE "' + stagingPrefix + '_main"');
        // await conn.query("SET FOREIGN_KEY_CHECKS = 1");
        console.log(`[SYNC] Dropped old database (init) ${stagingPrefix}_main: ${dropMainResult.warningStatus} warnings, ${dropMainResult.affectedRows} rows affected, ${dropMainRemainingResult.length} remaining`)
        syncLog += `\n[SYNC] Dropped old database (init) ${stagingPrefix}_main: ${dropMainResult.warningStatus} warnings, ${dropMainResult.affectedRows} rows affected, ${dropMainRemainingResult.length} remaining`

        // Loop through each of the databases
        for (const row of result) {
            const dbName = row.SCHEMA_NAME;

            // Determine whether it's a main database or a comp database
            const isMain = dbName == productionPrefix + '_main';
            const isComp = dbName.startsWith(productionPrefix + '_comp_');

            // The rest of the script should only be run on main and comp databases from the prod set
            if (!isMain && !isComp) { continue; }

            // These values are for "main" databases, comp databases will overwrite them
            let newDbName = dbName.replace(productionPrefix, stagingPrefix);

            console.log(`\n[SYNC] Found ${dbName}`)
            syncLog += `\n\n[SYNC] Found ${dbName}`

            if (isComp) {
                const compId = dbName.replace(productionPrefix + '_comp_', '');
                await conn.query(`USE ${productionPrefix}_main;`)
                const compResult = await conn.query(`SELECT * FROM ${productionPrefix}_main.comps WHERE uid = ?`, [compId]);

                if (compResult.length == 0) {
                    console.log(`[SYNC] WARNING: Comp database ${dbName} has no entry in the origin comps table`)
                    syncLog += `\n[SYNC] WARNING: Comp database ${dbName} has no entry in the origin comps table`
                    continue;
                }

                await conn.query(`DROP USER IF EXISTS '${stagingPrefix + '_' + compId + '_lp'}'@'localhost'`);
                await conn.query(`DROP USER IF EXISTS '${stagingPrefix + '_' + compId + '_hp'}'@'localhost'`);
            }

            await conn.query(`CREATE DATABASE ${newDbName}`);
            await conn.query(`USE ${newDbName}`);

            console.log(`[SYNC] Created new database ${newDbName}`)
            syncLog += `\n[SYNC] Created new database ${newDbName}`

            // Retrieve the list of tables in the main database
            const tableResult = await conn.query(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${dbName}'`);

            // Loop through each of the tables, copying them to the new database
            for (const table of [...tableResult]) {
                const tableName = table.TABLE_NAME;

                // ensure current table is not a view
                const isView = await conn.query(`SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = '${dbName}' AND TABLE_NAME = '${tableName}'`);
                if (isView.length > 0) { continue; }

                // console.log(`[SYNC] Copying table to ${newDbName} (${table.TABLE_NAME})`)
                // syncLog += `\n[SYNC] Copying table to ${newDbName} (${table.TABLE_NAME})`

                await conn.query(`DROP TABLE IF EXISTS ${tableName}`);
                await conn.query(`CREATE TABLE ${tableName} LIKE ${dbName}.${tableName}`);
                await conn.query(`INSERT INTO ${tableName} SELECT * FROM ${dbName}.${tableName}`);
            }

            console.log(`[SYNC] Finished syncing ${tableResult.length} tables to ${isMain ? 'MAIN' : 'COMP'} database ${newDbName}`)
            syncLog += `\n[SYNC] Finished syncing ${tableResult.length} tables to ${isMain ? 'MAIN' : 'COMP'} database ${newDbName}`
        }

        console.log("[SYNC] Finished syncing databases")
        syncLog += "\n[SYNC] Finished syncing databases"

        // Disconnect from the MariaDB server
        conn.release();
        await pool.end();
    } catch (err) {
        console.error(err);
        syncFailed = true;
        syncLog += "\n[SYNC] Failed to sync databases"
        syncLog += "\n[SYNC] Error: " + err
    }

    return [syncFailed, syncLog]
}

async function runSyncDatabases(fromDeployment, toDeployment) {
    console.log(`[SYNC] Syncing ${fromDeployment.title} to ${toDeployment.title}...`);
    let syncLog = `--- SYNCING ${fromDeployment.title} TO ${toDeployment.title} ---\n`;

    enableMaintenance(toDeployment);
    syncLog += `\n[SYNC] Started on ${new Date().toISOString()}\n\n`;

    const [syncFailed, newSyncLog] = await syncDatabases(fromDeployment, toDeployment);
    syncLog += newSyncLog;
    syncLog += `\n\n--- SYNC: ${syncFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (syncFailed) {
      writeLog(syncLog, false, "sync");
      console.log("[SYNC] Sync failed");
      return;
    }

    console.log('[SYNC] Recreating database users...')
    syncLog += "\n--- RECREATING DATABASE UESRS ---\n";
    const [rebuildUsersFailed, rebuildUsersLog] = await rebuildUsers(toDeployment);
    syncLog += rebuildUsersLog;
    syncLog += `\n\n--- REBUILD UESRS: ${rebuildUsersFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (rebuildUsersFailed) {
      writeLog(syncLog, false, "sync");
      console.error("[SYNC] Rebuild Users Failed");
      return;
    }

    // Because we have copied from production, some database changes might not have been applied
    // We need to run the migrations again to ensure that the database is up to date
    console.log('[SYNC] Running database migrations...')
    syncLog += "\n--- RUNNING DATABASE MIGRATIONS ---\n";
    const [migrateFailed, migrateLog] = await runDatabaseMigrations(toDeployment, true, toDeployment.no_composer_dev || false);
    console.log("[SYNC] Migration complete: ", migrateFailed ? "FAIL" : "SUCCESS");
    syncLog += migrateLog;
    syncLog += `\n\n--- DATABASE MIGRATIONS: ${migrateFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (migrateFailed) {
      writeLog(syncLog, false, "sync");
      console.error("[SYNC] Migration failed");
      return;
    }

    console.log('[SYNC] Rebuilding foreign keys...')
    syncLog += "\n--- REBUILDING FOREIGN KEYS ---\n";
    const [rebuildFKeysFailed, rebuildFKeysLog] = await rebuildForeignKeys(toDeployment);
    syncLog += rebuildFKeysLog;
    syncLog += `\n\n--- REBUILDING FOREIGN KEYS: ${rebuildFKeysFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (rebuildFKeysFailed) {
      writeLog(syncLog, false, "sync");
      console.error("[SYNC] Rebuild Foreign Keys failed");
      return;
    }

    // Anonymise the database
    console.log('[SYNC] Anonymising database...')
    syncLog += "\n--- ANONYMISING DATABASE ---\n";
    const [anonymiseFailed, anonymiseLog] = await anonymiseDatabase(toDeployment);
    console.log("[SYNC] Anonymisation complete: ", anonymiseFailed ? "FAIL" : "SUCCESS");
    syncLog += anonymiseLog;
    syncLog += `\n\n--- ANONYMISING DATABASE: ${anonymiseFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (anonymiseFailed) {
      writeLog(syncLog, false, "sync");
      console.error("[SYNC] Anonymisation failed");
      return;
    }

    // Rebuild the views
    console.log('[SYNC] Rebuilding views...')
    syncLog += "\n--- REBUILDING VIEWS ---\n";
    const [rebuildFailed, rebuildLog] = await rebuildViews(toDeployment);
    console.log("[SYNC] View rebuild complete: ", rebuildFailed ? "FAIL" : "SUCCESS");
    syncLog += rebuildLog;
    syncLog += `\n\n--- REBUILDING VIEWS: ${rebuildFailed ? "FAIL" : "SUCCESS"} --- \n\n`;

    if (rebuildFailed) {
      writeLog(syncLog, false, "sync");
      console.error("[SYNC] View rebuild failed");
      return;
    }

    syncLog += `\n[SYNC] Finished on ${new Date().toISOString()}\n\n`
    writeLog(syncLog, true, "sync");
    console.log("[SYNC] Sync complete")
    disableMaintenance(toDeployment);
}

module.exports = {
    syncDatabases,
    runSyncDatabases
};
