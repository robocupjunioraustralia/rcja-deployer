const mariadb = require('mariadb');
const { spawn } = require('child_process');

async function rebuildForeignKeys(deploymentInfo) {
    let rebuildFKeysFailed = false;
    let rebuildFKeysLog = "";
    
    try {
        const runFKPHP = async (database_name, database_type, deploymentInfo) => {
            return new Promise((resolve, reject) => {
                const viewCmd = spawn(process.env.PHP_PATH, [
                    database_type == "comp" ? "utils/db_files/1.5_tables_script_fks.php" : "utils/db_files/main_1.5_tables_script_fks.php",
                    database_name
                ], {
                    cwd: deploymentInfo.path
                });
                
                viewCmd.on('exit', (code) => {
                    if (code === 0) {
                        console.log(`[REBUILDFK]    PHP Migration for ${database_name} complete`);
                        rebuildFKeysLog += `\n[REBUILDFK]    PHP Migration for ${database_name} complete`;
                        resolve();
                    } else {
                        console.error(`[REBUILDFK]    Error running PHP view file on ${database_name}`);
                        rebuildFKeysLog += `\n[REBUILDFK]    Error running PHP view file on ${database_name}`;
                        reject(code);
                    }
                });
                
                viewCmd.on('error', (err) => {
                    console.error(`[REBUILDFK]    Error running PHP view file on ${database_name}`);
                    rebuildFKeysLog += `\n[REBUILDFK]    Error running PHP view file on ${database_name}`;
                    reject(err);
                });
                
                viewCmd.stdout.on('data', (data) => {
                    console.log(data.toString());
                    rebuildFKeysLog += data;
                });
                
                viewCmd.stderr.on('data', (data) => {
                    console.log(data.toString());
                    rebuildFKeysLog += data;
                });
            });
        }

        // Connect to the MariaDB server
        const pool = mariadb.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        });
        const conn = await pool.getConnection();
        console.log("[REBUILDFK] Connected to MariaDB server");
        rebuildFKeysLog += "\n[REBUILDFK] Connected to MariaDB server";

        // Rebuild main 
        console.log(`[REBUILDFK] Rebuilding foreign keys in ${deploymentInfo.database_prefix}_main`);
        rebuildFKeysLog += `\n[REBUILDFK] Rebuilding foreign keys in ${deploymentInfo.database_prefix}_main`;
        await conn.query(`USE ${deploymentInfo.database_prefix}_main`);
        const existingKeysToDrop = await conn.query(
            `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE CONSTRAINT_SCHEMA = '${deploymentInfo.database_prefix}_main'
                AND REFERENCED_COLUMN_NAME IS NOT NULL 
                AND REFERENCED_TABLE_NAME IS NOT NULL;`);
        
        for (const key of existingKeysToDrop) {
            const tableName = key.TABLE_NAME;
            const constraintName = key.CONSTRAINT_NAME;
            const columnName = key.COLUMN_NAME;

            await conn.query(`ALTER TABLE ${tableName} DROP FOREIGN KEY ${constraintName}`);
            await conn.query(`ALTER TABLE ${tableName} DROP INDEX IF EXISTS ${constraintName}`);
            await conn.query(`ALTER TABLE ${tableName} DROP INDEX IF EXISTS ${columnName}`);
        }

        if (existingKeysToDrop.length > 0) {
            console.log(`[REBUILDFK]    Dropped ${existingKeysToDrop.length} existing foreign keys`);
            rebuildFKeysLog += `\n[REBUILDFK]    Dropped ${existingKeysToDrop.length} existing foreign keys`;
        }


        await runFKPHP(`${deploymentInfo.database_prefix}_main`, "main", deploymentInfo).catch((err) => {
            console.error('[REBUILDFK]    Error running PHP view file:', err?.message || err);
            rebuildFKeysLog += '\n[REBUILDFK]    Error running PHP view file: ' + (err?.message || err);
            rebuildFKeysFailed = true;
        });

        if (rebuildFKeysFailed) {
            return [rebuildFKeysFailed, rebuildFKeysLog];
        }

        // Retrieve the list of comp databases
        const compDatabases = await conn.query(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '${deploymentInfo.database_prefix}_comp_%'`);

        for (const compDb of compDatabases) {
            const dbName = compDb.SCHEMA_NAME;
            
            console.log(`[REBUILDFK] Rebuilding foreign keys in ${dbName}`);
            rebuildFKeysLog += `\n[REBUILDFK] Rebuilding foreign keys in ${dbName}`;

            await conn.query(`USE ${dbName}`);
            const existingKeysToDrop = await conn.query(
                `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME
                 FROM information_schema.KEY_COLUMN_USAGE
                 WHERE CONSTRAINT_SCHEMA = '${dbName}'
                    AND REFERENCED_COLUMN_NAME IS NOT NULL 
                    AND REFERENCED_TABLE_NAME IS NOT NULL;`);
                    
            for (const key of existingKeysToDrop) {
                const tableName = key.TABLE_NAME;
                const constraintName = key.CONSTRAINT_NAME;

                await conn.query(`ALTER TABLE ${tableName} DROP FOREIGN KEY ${constraintName}`);
            }
            
            if (existingKeysToDrop.length > 0) {
                console.log(`[REBUILDFK]    Dropped ${existingKeysToDrop.length} existing foreign keys`);
                rebuildFKeysLog += `\n[REBUILDFK]    Dropped ${existingKeysToDrop.length} existing foreign keys`;
            }

            await runFKPHP(dbName, "comp", deploymentInfo).catch((err) => {
                console.error('[REBUILDFK]    Error running PHP view file:', err?.message || err);
                rebuildFKeysLog += '\n[REBUILDFK]    Error running PHP view file: ' + (err?.message || err);
                rebuildFKeysFailed = true;
            });

            if (rebuildFKeysFailed) {
                break;
            }
        }

        if (!rebuildFKeysFailed) {
            console.log(`[REBUILDFK] Rebuilding of all foreign keys complete`);
            rebuildFKeysLog += `\n[REBUILDFK] Rebuilding of all foreign keys complete`;
        }
        
        // Disconnect from the MariaDB server
        conn.release();
        await pool.end();
    } catch (err) {
        console.error(err);
        rebuildFKeysFailed = true;
        rebuildFKeysLog += "\n[REBUILDFK] Failed to rebuild foreign keys"
        rebuildFKeysLog += "\n[REBUILDFK] Error: " + err
    }

    return [rebuildFKeysFailed, rebuildFKeysLog]
}

module.exports = {
    rebuildForeignKeys
}