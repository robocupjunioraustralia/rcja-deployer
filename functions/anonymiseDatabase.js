const mariadb = require('mariadb');
const phppass = require("node-php-password");
const { faker } = require('@faker-js/faker');

async function anonymiseDatabase(deploymentInfo) {
    let anonFailed = false;
    let anonLog = "";
    
    try {
        // Connect to the MariaDB server
        const pool = mariadb.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        });
        const conn = await pool.getConnection();
        console.log("[ANONYMISE] Connected to MariaDB server");
        anonLog += "\n[ANONYMISE] Connected to MariaDB server";

        // Check if rcj_cms_deployer_cache database exists
        const cacheDbExists = await conn.query(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'rcj_cms_deployer_cache'`);
        if (cacheDbExists.length == 0) {
            console.log("[ANONYMISE] rcj_cms_deployer_cache database does not exist, please create it using db.sql");
            anonLog += "\n[ANONYMISE] rcj_cms_deployer_cache database does not exist, please create it using db.sql";

            conn.release()
            await pool.end();
            return [true, anonLog];
        }

        // Retrieve the list of comp databases
        const compDatabases = await conn.query(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE '${deploymentInfo.database_prefix}_comp_%'`);
        
        const importedMentorCache = await conn.query(`SELECT * FROM rcj_cms_deployer_cache.imported_mentor`);
        const importedTeamMemberCache = await conn.query(`SELECT * FROM rcj_cms_deployer_cache.imported_team_member`);
        const userCache = await conn.query(`SELECT * FROM rcj_cms_deployer_cache.user`);

        // Iterate over each comp database and anonymize the data in the imported_mentor and imported_team_member tables
        for (const compDb of compDatabases) {
            const dbName = compDb.SCHEMA_NAME;
            const compId = dbName.replace(`${deploymentInfo.database_prefix}_comp_`, '');
            
            console.log(`[ANONYMISE] Anonymizing data in ${dbName}`);
            anonLog += `\n[ANONYMISE] Anonymizing data in ${dbName}`;
            
            
            // Connect to the comp database
            await conn.query(`USE ${dbName}`);
            
            // Anonymize the data in the imported_mentor table
            const importedMentorRows = await conn.query('SELECT * FROM imported_mentor');
            let numNewMentors = 0; 
            for (const row of importedMentorRows) {
                const cachedMentor = importedMentorCache.find(cacheRow => cacheRow.uid_imported_mentor == row.uid && cacheRow.uid_comp == compId);
                
                if (cachedMentor) {
                    await conn.query(
                        'UPDATE imported_mentor SET mentor_first = ?, mentor_last = ?, mentor_email = ?, mentor_phone = ? WHERE uid = ?',
                        [cachedMentor.mentor_first, cachedMentor.mentor_last, cachedMentor.mentor_email, cachedMentor.mentor_phone, row.uid]
                    );
                    continue;
                }

                const newMentor = {
                    mentor_first: faker.name.firstName(),
                    mentor_last: faker.name.lastName(),
                    mentor_email: faker.internet.email(),
                    mentor_phone: faker.phone.number("04########")
                }
                await conn.query(
                    'UPDATE imported_mentor SET mentor_first = ?, mentor_last = ?, mentor_email = ?, mentor_phone = ? WHERE uid = ?',
                    [newMentor.mentor_first, newMentor.mentor_last, newMentor.mentor_email, newMentor.mentor_phone, row.uid]
                );
                await conn.query(
                    'INSERT INTO rcj_cms_deployer_cache.imported_mentor (uid_imported_mentor, uid_comp, mentor_first, mentor_last, mentor_email, mentor_phone, old_mentor_first, old_mentor_last, old_mentor_email, old_mentor_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [row.uid, compId, newMentor.mentor_first, newMentor.mentor_last, newMentor.mentor_email, newMentor.mentor_phone, row.mentor_first, row.mentor_last, row.mentor_email, row.mentor_phone]
                );
                numNewMentors++;
            }
            console.log(`[ANONYMISE] IMPORTED_MENTOR: ${importedMentorRows.length} updated, ${numNewMentors} new`);
            anonLog += `\n[ANONYMISE] IMPORTED_MENTOR: ${importedMentorRows.length} updated, ${numNewMentors} new`;            
            
            // Anonymize the data in the imported_team_member table
            const importedTeamMemberRows = await conn.query('SELECT * FROM imported_team_member');
            let numNewTeamMembers = 0;
            for (const row of importedTeamMemberRows) {
                const cachedTeamMember = importedTeamMemberCache.find(cacheRow => cacheRow.uid_imported_team_member == row.uid && cacheRow.uid_comp == compId);

                if (cachedTeamMember) {
                    await conn.query(
                        'UPDATE imported_team_member SET first_name = ?, last_name = ? WHERE uid = ?',
                        [cachedTeamMember.first_name, cachedTeamMember.last_name, row.uid]
                    );
                    continue;
                }

                const newTeamMember = {
                    first_name: faker.name.firstName(),
                    last_name: faker.name.lastName()
                }
                await conn.query(
                    'UPDATE imported_team_member SET first_name = ?, last_name = ? WHERE uid = ?',
                    [newTeamMember.first_name, newTeamMember.last_name, row.uid]
                );
                await conn.query(
                    'INSERT INTO rcj_cms_deployer_cache.imported_team_member (uid_imported_team_member, uid_comp, first_name, last_name, old_first_name, old_last_name) VALUES (?, ?, ?, ?, ?, ?)',
                    [row.uid, compId, newTeamMember.first_name, newTeamMember.last_name, row.first_name, row.last_name]
                );
                numNewTeamMembers++;
            }
            console.log(`[ANONYMISE] IMPORTED_TEAM_MEMBER: ${importedTeamMemberRows.length} updated, ${numNewTeamMembers} new`);
            anonLog += `\n[ANONYMISE] IMPORTED_TEAM_MEMBER: ${importedTeamMemberRows.length} updated, ${numNewTeamMembers} new`;

            // Anonymize the data in the user table
            const userRows = await conn.query('SELECT * FROM user');
            let numNewUsers = 0;
            for (const row of userRows) {
                if (row.username == "rcjsupport") {
                    continue;
                }
                const cachedUser = userCache.find(cacheRow => cacheRow.uid_user == row.uid && cacheRow.uid_comp == compId);

                if (cachedUser) {
                    await conn.query(
                        'UPDATE user SET first_name = ?, last_name = ?, phone_number = ?, username = ? WHERE uid = ?',
                        [cachedUser.first_name, cachedUser.last_name, cachedUser.phone_number, cachedUser.username, row.uid]
                    );
                    continue;
                }

                const newUser = {
                    first_name: faker.name.firstName(),
                    last_name: faker.name.lastName(),
                    phone_number: faker.phone.number("04########"),
                    username: faker.internet.userName(),                    
                }
                await conn.query(
                    'UPDATE user SET first_name = ?, last_name = ?, phone_number = ?, username = ? WHERE uid = ?',
                    [newUser.first_name, newUser.last_name, newUser.phone_number, newUser.username, row.uid]
                );
                await conn.query(
                    'INSERT INTO rcj_cms_deployer_cache.user (uid_user, uid_comp, first_name, last_name, phone_number, username, old_first_name, old_last_name, old_phone_number, old_username) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [row.uid, compId, newUser.first_name, newUser.last_name, newUser.phone_number, newUser.username, row.first_name, row.last_name, row.phone_number, row.username]
                );
                numNewUsers++;
            }
            console.log(`[ANONYMISE] USER: ${userRows.length} updated, ${numNewUsers} new`);
            anonLog += `\n[ANONYMISE] USER: ${userRows.length} updated, ${numNewUsers} new`;

            // Anonymise user password/pin 
            let numPassUpdated = 0;
            let numPinUpdated = 0;
            for (const row of userRows) {
                let newPassHash = null;
                if (process.env.ANON_PASSWORD) {
                    newPassHash = await phppass.hash(process.env.ANON_PASSWORD, "PASSWORD_BCRYPT");
                } else {
                    newPassHash = await phppass.hash(faker.internet.password(), "PASSWORD_BCRYPT");
                }

                if (row.password_hash) {
                    await conn.query(
                        'UPDATE user SET password_hash = ? WHERE uid = ?',
                        [newPassHash, row.uid]
                    );
                    numPassUpdated++;
                }
                if (row.qap) {
                    await conn.query(
                        'UPDATE user SET qap = ? WHERE uid = ?',
                        [newPassHash, row.uid]
                    );
                    numPinUpdated++;
                }
            }
            console.log(`[ANONYMISE] USER: ${numPassUpdated} passwords updated, ${numPinUpdated} pins updated`);

            // Anonymise session IP address logs
            const distinctIPs = await conn.query('SELECT DISTINCT remote_ip FROM sessions_log');
            for (const row of distinctIPs) {
                const newIp = faker.internet.ip();

                await conn.query(
                    'UPDATE sessions_log SET remote_ip = ? WHERE remote_ip = ?',
                    [newIp, row.remote_ip]
                );
            }
            console.log(`[ANONYMISE] SESSIONS_LOG: ${distinctIPs.length} IPs anonymised`);

            console.log(`[ANONYMISE] Anonymization of ${dbName} complete`);
            anonLog += `\n[ANONYMISE] Anonymization of ${dbName} complete`;
        }

        console.log(`[ANONYMISE] Anonymization of all databases complete`);
        anonLog += `\n[ANONYMISE] Anonymization of all databases complete`;

        // Disconnect from the MariaDB server
        conn.release();
        await pool.end();
    } catch (err) {
        console.error(err);
        anonFailed = true;
        anonLog += "\n[ANONYMISE] Failed to sync databases"
        anonLog += "\n[ANONYMISE] Error: " + err
    }

    return [anonFailed, anonLog]
}

module.exports = {
    anonymiseDatabase
}