import { createReadStream } from 'node:fs';
import { createDatabaseBackup } from './backup';
import type { Deployment } from './deployment';
import { setMaintenanceMode, importBackup } from './docker';
import { runDatabaseMigrations } from './migrate';

/**
 * Syncronise the databases between two different instances
 * @param source The deployment to copy from
 * @param target The deployment to copy to
 * @returns results
 */
export async function syncDatabases(source: Deployment, target: Deployment): Promise<{ error: boolean; log: string; }> {
    console.info(`[SYNC] Syncing ${source.title} to ${target.title}...`);
    let syncLog = `[SYNC] Syncing ${source.title} to ${target.title}...\n`;
    syncLog += `\n[SYNC] Started on ${new Date().toISOString()}\n\n`;

    const maintenanceEnableResult = await setMaintenanceMode(target, true);
    syncLog += maintenanceEnableResult.log;
    if (maintenanceEnableResult.error) {
        return { error: true, log: syncLog };
    }

    // export the databases from the source deployment
    // TODO: anonymised backup
    console.info('[SYNC] Backing up source deployment...')
    syncLog += "\n[SYNC] Backing up source deployment...\n";

    const backupResult = await createDatabaseBackup(source, "_sync");
    syncLog += backupResult.result.log;
    if (backupResult.result.error) {
        return { error: true, log: syncLog };
    }

    // import that backup to the target deployment
    console.info('[SYNC] Importing backup to target deployment...')
    syncLog += "\n[SYNC] Importing backup to target deployment...\n";

    const backupFileStream = createReadStream(backupResult.backupFile);
    const importResult = await importBackup(target, backupFileStream);
    syncLog += importResult.log;
    if (importResult.error) {
        return { error: true, log: syncLog };
    }

    // since this occured between instances, some database changes might not have been applied
    // so we need to run the migrations again to ensure that the database is up to date
    console.info('[SYNC] Running database migrations...')
    syncLog += "\n[SYNC] Running database migrations...\n";

    const migrateResult = await runDatabaseMigrations(target);
    syncLog += migrateResult.log;
    if (migrateResult.error) {
        return { error: true, log: syncLog };
    }

    const maintenanceDisableResult = await setMaintenanceMode(target, false);
    syncLog += maintenanceDisableResult.log;
    if (maintenanceDisableResult.error) {
        return { error: true, log: syncLog };
    }

    console.info("[SYNC] Sync complete")
    syncLog += `\n[SYNC] Finished on ${new Date().toISOString()}\n\n`

    return { error: false, log: syncLog };
}
