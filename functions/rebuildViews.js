const mariadb = require('mariadb');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function rebuildViews(deploymentInfo) {
    let rebuildViewsFailed = false;
    let rebuildViewsLog = "";


    try {
        const runViewSQL = async (database_name, deploymentInfo) => {
            return new Promise((resolve, reject) => {
                const viewCmd = spawn(process.env.MYSQL_PATH, [
                    '-u',
                    process.env.DB_USER,
                    '-p' + process.env.DB_PASSWORD,
                    database_name,
                ], { shell: true });

                const viewScript = fs.readFileSync(path.join(deploymentInfo.path, 'utils/db_files/2_views_script.sql'), 'utf8');
                viewCmd.stdin.write(viewScript);
                viewCmd.stdin.end();

                viewCmd.on('exit', (code) => {
                    if (code === 0) {
                        console.log(`[MIGRATE] View file complete on ${database_name}`);
                        rebuildViewsLog += `\n[MIGRATE] View file complete on ${database_name}`;
                        resolve();
                    } else {
                        console.error(`[MIGRATE] Error running view file on ${database_name}`);
                        rebuildViewsLog += `\n[MIGRATE] Error running view file on ${database_name}`;
                        reject(code);
                    }
                });

                viewCmd.on('error', (err) => {
                    console.error(`[REBUILDVIEW] Error running view file on ${database_name}`);
                    rebuildViewsLog += `\n[REBUILDVIEW] Error running view file on ${database_name}`;
                    reject(err);
                });

                viewCmd.stdout.on('data', (data) => {
                    console.log(data.toString());
                    rebuildViewsLog += data;
                });

                viewCmd.stderr.on('data', (data) => {
                    console.log(data.toString());
                    rebuildViewsLog += data;
                });
            });
        }

        const runViewPHP = async (database_name, deploymentInfo) => {
            return new Promise((resolve, reject) => {
                const viewCmd = spawn(process.env.PHP_PATH, [
                    "utils/db_files/2.5_views_script_alt.php",
                    database_name
                ], {
                    cwd: deploymentInfo.path,
                    shell: true
                });

                viewCmd.on('exit', (code) => {
                    if (code === 0) {
                        console.log(`[REBUILDVIEW] PHP Migration for ${database_name} complete`);
                        rebuildViewsLog += `\n[REBUILDVIEW] PHP Migration for ${database_name} complete`;
                        resolve();
                    } else {
                        console.error(`[REBUILDVIEW] Error running PHP view file on ${database_name}`);
                        rebuildViewsLog += `\n[REBUILDVIEW] Error running PHP view file on ${database_name}`;
                        reject(code);
                    }
                });

                viewCmd.on('error', (err) => {
                    console.error(`[REBUILDVIEW] Error running PHP view file on ${database_name}`);
                    rebuildViewsLog += `\n[REBUILDVIEW] Error running PHP view file on ${database_name}`;
                    reject(err);
                });

                viewCmd.stdout.on('data', (data) => {
                    console.log(data.toString());
                    rebuildViewsLog += data;
                });

                viewCmd.stderr.on('data', (data) => {
                    console.log(data.toString());
                    rebuildViewsLog += data;
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
        console.log("[REBUILDVIEW] Connected to MariaDB server");
        rebuildViewsLog += "\n[REBUILDVIEW] Connected to MariaDB server";

        // Retrieve the list of comp databases
        const compDatabases = await conn.query(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '${deploymentInfo.database_prefix}_comp_%' ORDER BY SCHEMA_NAME DESC`);

        for (const compDb of compDatabases) {
            const dbName = compDb.SCHEMA_NAME;

            console.log(`[REBUILDVIEW] Rebuilding SQL views in ${dbName}`);
            rebuildViewsLog += `\n[REBUILDVIEW] Rebuilding SQL views in ${dbName}`;

            // Connect to the comp database
            await conn.query(`USE ${dbName}`);

            await runViewSQL(dbName, deploymentInfo).catch((err) => {
                console.error('[REBUILDVIEW] Error running SQL view file:', err?.message || err);
                rebuildViewsLog += '\n[REBUILDVIEW] Error running SQL view file: ' + (err?.message || err);
                rebuildViewsFailed = true;
            });

            console.log(`[REBUILDVIEW] Rebuilding SQL views in ${dbName} complete`);
            rebuildViewsLog += `\n[REBUILDVIEW] Rebuilding SQL views in ${dbName} complete`;

            await runViewPHP(dbName, deploymentInfo).catch((err) => {
                console.error('[REBUILDVIEW] Error running PHP view file:', err?.message || err);
                rebuildViewsLog += '\n[REBUILDVIEW] Error running PHP view file: ' + (err?.message || err);
                rebuildViewsFailed = true;
            });

            if (rebuildViewsFailed) {
                break;
            }
        }

        if (!rebuildViewsFailed) {
            console.log(`[REBUILDVIEW] Rebuilding of all views complete`);
            rebuildViewsLog += `\n[REBUILDVIEW] Rebuilding of all views complete`;
        }

        // Disconnect from the MariaDB server
        conn.release();
        await pool.end();
    } catch (err) {
        console.error(err);
        rebuildViewsFailed = true;
        rebuildViewsLog += "\n[REBUILDVIEW] Failed to rebuild views"
        rebuildViewsLog += "\n[REBUILDVIEW] Error: " + err
    }

    return [rebuildViewsFailed, rebuildViewsLog]
}

module.exports = {
    rebuildViews
}
