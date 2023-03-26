const mariadb = require('mariadb');
const fs = require('fs');
const path = require('path');
const phpParser = require('php-parser');

// This function syncronises the databases between the production and staging servers
// All of the databases on the production server will be copied to the staging server
// The staging server will have the same databases, but with a different prefix
async function syncDatabases(fromDeployment, toDeployment) {
    let syncLog = "";
    let syncFailed = false;
    try {
        productionPrefix = fromDeployment.database_prefix;
        stagingPrefix = toDeployment.database_prefix;

        // Retrieve database credentials from the connectdb.php file
        const connectdb = fs.readFileSync(path.join(toDeployment.path, '/utils/connect_db.php'), 'utf8');
        const ast = phpParser.parseCode(connectdb);

        const db_lp_un = ast.children.find((node) => node.kind === "expressionstatement" && node.expression.left.name === "db_lp_un").expression.right.value;
        const db_lp_pw = ast.children.find((node) => node.kind === "expressionstatement" && node.expression.left.name === "db_lp_pw").expression.right.value;
        const db_hp_un = ast.children.find((node) => node.kind === "expressionstatement" && node.expression.left.name === "db_hp_un").expression.right.value;
        const db_hp_pw = ast.children.find((node) => node.kind === "expressionstatement" && node.expression.left.name === "db_hp_pw").expression.right.value;

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

        // Loop through each of the databases
        for (const row of result) {
            const dbName = row.SCHEMA_NAME;
            
            // Determine whether it's a main database or a comp database
            const isMain = dbName == productionPrefix + '_main';
            const isComp = dbName.startsWith(productionPrefix + '_comp_');
            
            if (!isMain && !isComp) { continue; }         

            // These values are for "main" databases, comp databases will overwrite them
            let newDbName = dbName.replace(productionPrefix, stagingPrefix);
            let newDbLpUser = db_lp_un.replace(productionPrefix, stagingPrefix);
            let newDbLpPass = db_lp_pw;
            let newDbHpUser = db_hp_un.replace(productionPrefix, stagingPrefix);
            let newDbHpPass = db_hp_pw;

            console.log(`[SYNC] Syncing ${isMain ? 'main' : 'comp'} database ${dbName} to ${newDbName}`)
            syncLog += `\n[SYNC] Syncing ${isMain ? 'main' : 'comp'} database ${dbName} to ${newDbName}`
            
            if (isComp) {
                const compId = dbName.replace(productionPrefix + '_comp_', '');
                await conn.query(`USE ${productionPrefix}_main;`)
                const compResult = await conn.query(`SELECT * FROM ${productionPrefix}_main.comps WHERE uid = ?`, [compId]);
                
                if (compResult.length == 0) { continue; }
                
                newDbLpUser = stagingPrefix + '_' + compId + '_lp';
                newDbLpPass = compResult[0].db_lp_pwd;
                newDbHpUser = stagingPrefix + '_' + compId + '_hp';
                newDbHpPass = compResult[0].db_hp_pwd;

                console.log(`[SYNC] Comp database ${dbName} has LP user ${newDbLpUser} and HP user ${newDbHpUser}`)
                syncLog += `\n[SYNC] Comp database ${dbName} has LP user ${newDbLpUser} and HP user ${newDbHpUser}`
            }
            
            const dropResult = await conn.query(`DROP DATABASE IF EXISTS ${newDbName}`);
            if (dropResult.warningCount > 0) {
                console.log(`[SYNC] Dropped old database ${newDbName}`)
                syncLog += `\n[SYNC] Dropped old database ${newDbName}`
            }

            await conn.query(`CREATE DATABASE ${newDbName}`);
            await conn.query(`USE ${newDbName}`);

            console.log(`[SYNC] Created new database ${newDbName} and switched to it`)
            syncLog += `\n[SYNC] Created new database ${newDbName} and switched to it`
            
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

            console.log(`[SYNC] Copied ${tableResult.length} tables to ${newDbName}`)
            syncLog += `\n[SYNC] Copied ${tableResult.length} tables to ${newDbName}`
            
            // Create the two users for the new database
            const dropUserLpResult = await conn.query(`DROP USER IF EXISTS '${newDbLpUser}'@'localhost'`);
            if (dropUserLpResult.warningCount > 0) {
                console.log(`[SYNC] Dropped old LP user ${newDbLpUser}`)
                syncLog += `\n[SYNC] Dropped old LP user ${newDbLpUser}`
            }
            const dropUserHpResult = await conn.query(`DROP USER IF EXISTS '${newDbHpUser}'@'localhost'`);
            if (dropUserHpResult.warningCount > 0) {
                console.log(`[SYNC] Dropped old HP user ${newDbHpUser}`)
                syncLog += `\n[SYNC] Dropped old HP user ${newDbHpUser}`
            }

            await conn.query(`CREATE USER '${newDbLpUser}'@'localhost' IDENTIFIED BY '${newDbLpPass}'`);
            await conn.query(`CREATE USER '${newDbHpUser}'@'localhost' IDENTIFIED BY '${newDbHpPass}'`);
            await conn.query(`GRANT SELECT ON \`${newDbName}\`.* TO '${newDbLpUser}'@'localhost'`);
            await conn.query(`GRANT SELECT, INSERT, UPDATE, DELETE, DROP, CREATE VIEW ON \`${newDbName}\`.* TO '${newDbHpUser}'@'localhost'`);

            console.log(`[SYNC] Created LP user ${newDbLpUser} and HP user ${newDbHpUser}`)
            syncLog += `\n[SYNC] Created LP user ${newDbLpUser} and HP user ${newDbHpUser}`

            console.log(`[SYNC] Finished syncing ${isMain ? 'main' : 'comp'} database ${dbName} to ${newDbName}`)
            syncLog += `\n[SYNC] Finished syncing ${isMain ? 'main' : 'comp'} database ${dbName} to ${newDbName}`
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

module.exports = {
    syncDatabases
};