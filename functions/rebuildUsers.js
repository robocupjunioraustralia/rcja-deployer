const mariadb = require('mariadb');
const fs = require('fs');
const path = require('path');
const phpParser = require('php-parser');

async function rebuildUsers(deploymentInfo) {
    let rebuildUsersFailed = false;
    let rebuildUsersLog = "";
    
    try {
        // Retrieve database credentials from the deployment config
        const connectdb = fs.readFileSync(path.join(deploymentInfo.path, '/utils/config.php'), 'utf8');
        const ast = phpParser.parseCode(connectdb);

        const db_lp_pw = ast.children.find((node) => node.kind === "expressionstatement" && node.expression.left.name === "db_lp_pw").expression.right.value;
        const db_hp_pw = ast.children.find((node) => node.kind === "expressionstatement" && node.expression.left.name === "db_hp_pw").expression.right.value;

        console.log("[REBUILDUSERS] Retrieved credentials from config.php");
        rebuildUsersLog += "\n[REBUILDUSERS] Retrieved credentials from config.php";

        // Connect to the MariaDB server
        const pool = mariadb.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        });
        const conn = await pool.getConnection();
        console.log("[REBUILDUSERS] Connected to MariaDB server");
        rebuildUsersLog += "\n[REBUILDUSERS] Connected to MariaDB server";

        await conn.query(`USE ${deploymentInfo.database_prefix}_main`);

        await conn.query(`DROP USER IF EXISTS '${deploymentInfo.database_prefix}_lp'@'localhost'`);
        await conn.query(`DROP USER IF EXISTS '${deploymentInfo.database_prefix}_hp'@'localhost'`);

        await conn.query(`CREATE USER '${deploymentInfo.database_prefix}_lp'@'localhost' IDENTIFIED BY '${db_lp_pw}'`);
        await conn.query(`CREATE USER '${deploymentInfo.database_prefix}_hp'@'localhost' IDENTIFIED BY '${db_hp_pw}'`);
        
        await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.* TO '${deploymentInfo.database_prefix}_lp'@'localhost'`);
        await conn.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, FILE, INDEX, ALTER, CREATE TEMPORARY TABLES, CREATE VIEW, EVENT, TRIGGER, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EXECUTE ON *.* TO '${deploymentInfo.database_prefix}_hp'@'localhost'`);
        
        console.log(`[REBUILDUSERS] Rebuild users: ${deploymentInfo.database_prefix}_lp and ${deploymentInfo.database_prefix}_hp`);
        rebuildUsersLog += `\n[REBUILDUSERS] Rebuild users: ${deploymentInfo.database_prefix}_lp and ${deploymentInfo.database_prefix}_hp`;
        
        const allComps = await conn.query("SELECT uid, db_lp_pwd, db_hp_pwd FROM comps");

        for (const comp of allComps) {
            const comp_id = comp.uid;

            const un_lp = `${deploymentInfo.database_prefix}_${comp_id}_lp`;
            const un_hp = `${deploymentInfo.database_prefix}_${comp_id}_hp`;

            const lp_random_pw = comp.db_lp_pwd;
            const hp_random_pw = comp.db_hp_pwd;
            
            await conn.query(`DROP USER IF EXISTS '${un_lp}'@'localhost'`);
            await conn.query(`DROP USER IF EXISTS '${un_hp}'@'localhost'`);

            await conn.query(`UPDATE comps SET db_lp_pwd = '${lp_random_pw}', db_hp_pwd = '${hp_random_pw}' WHERE uid = '${comp_id}'`);

            await conn.query(`CREATE USER '${un_lp}'@'localhost' IDENTIFIED BY '${lp_random_pw}'`);
            await conn.query(`CREATE USER '${un_hp}'@'localhost' IDENTIFIED BY '${hp_random_pw}'`);

            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_comp_${comp_id}.* TO '${un_lp}'@'localhost'`);
            await conn.query(`GRANT SELECT, INSERT, UPDATE, DELETE, DROP, CREATE VIEW ON ${deploymentInfo.database_prefix}_comp_${comp_id}.* TO '${un_hp}'@'localhost'`);

            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_physical TO '${un_lp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_rule TO '${un_lp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_set TO '${un_lp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_set_links TO '${un_lp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_tag TO '${un_lp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_tag_links TO '${un_lp}'@'localhost'`);

            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_physical TO '${un_hp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_rule TO '${un_hp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_set TO '${un_hp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_set_links TO '${un_hp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_tag TO '${un_hp}'@'localhost'`);
            await conn.query(`GRANT SELECT ON ${deploymentInfo.database_prefix}_main.line_tile_tag_links TO '${un_hp}'@'localhost'`);

            console.log(`[REBUILDUSERS] Rebuild users: ${un_lp} and ${un_hp}`);
            rebuildUsersLog += `\n[REBUILDUSERS] Rebuild users: ${un_lp} and ${un_hp}`;
        }
        
        conn.release();
        await pool.end();
    } catch (err) {
        console.error(err);
        rebuildUsersFailed = true;
        rebuildUsersLog += "\n[REBUILDUSERS] Failed to rebuild views"
        rebuildUsersLog += "\n[REBUILDUSERS] Error: " + err
    }

    return [rebuildUsersFailed, rebuildUsersLog]
}

module.exports = {
    rebuildUsers
}