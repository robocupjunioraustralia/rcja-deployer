import { existsSync } from 'node:fs';
import { deploymentHasUncommittedChanges, getCurrentBranch, checkoutDeploymentTo } from './deployment';
import type { Deployment } from './deployment';
import { runMigrate, start, stop } from './docker';

/**
 * Run database migrations for an RCJ CMS deployment, including stepping through incompatible releases if necessary
 * @param deployment target
 * @returns error status and log
 */
export async function runDatabaseMigrations(deployment: Deployment): Promise<{ error: boolean; log: string }> {
    let migrationLog = '';

    /**
     * this version of the deployer is only compatible with instances running with docker compose (26.1.0 and newer)
     * in case someone tries to run it on an older instance, suggest that they go back to a compatible deployer release
     */
    if (!existsSync(deployment.path + '/docker-compose.yml')) {
        const failMessage = `\n[MIGRATE] Unable to proceed: Incompatible release detected`
            + "\n  - This version of the deployer requires the target deployment to be running v26.1.0 or newer"
            + "\n  - To migrate an instance running v24.4.0 to v25.4.2, use https://github.com/robocupjunioraustralia/rcja-deployer/releases/tag/25.4.2";

        console.error(failMessage);
        migrationLog += `\n${failMessage}`;
        return { error: true, log: migrationLog };
    }

    // Run the migrations
    const initialMigrateResult = await runMigrate(deployment);
    migrationLog += initialMigrateResult.log;
    if (!initialMigrateResult.error) {
        // completed successfully, nothing more to do
        return { error: false, log: migrationLog };
    }

    if (initialMigrateResult.incompatibleRelease === undefined) {
        // something unexpected went wrong
        return { error: true, log: migrationLog };
    }

    // migration failed due to an incompatible release, step through the releases one by one
    const releaseInfo = initialMigrateResult.incompatibleRelease;

    console.info("[MIGRATE] Attempting to step through incompatible releases:");
    migrationLog += "\n[MIGRATE] Attempting to step through incompatible releases:";

    /**
     * If there exists migrations that are not for the current release,
     * and there are uncommitted changes in the deployment directory,
     * then we should not proceed with the migration - as it may result in data loss when we switch tags
     */
    if (await deploymentHasUncommittedChanges(deployment)) {
        const failMessage = `\n[MIGRATE] Unable to proceed: Uncommitted changes in deployment directory and migrations outside current release`
            + `\n  - You are currently on: ${releaseInfo.currentRelease}`
            + `\n  - New migrations found for: ${releaseInfo.targetReleases.join(', ')}`
            + `\n  - To avoid data loss, please commit or stash your changes before proceeding`;

        console.error(failMessage);
        migrationLog += `\n${failMessage}`;
        return { error: true, log: migrationLog };
    }

    const initialBranch = await getCurrentBranch(deployment);

    // Run migrations for each release, this list will also include the original target release at the end
    for (const targetRelease of releaseInfo.targetReleases) {
        // Before changing tags, stop the instance
        console.info(`[MIGRATE] Stopping instance before changing tags...`);
        migrationLog += `\n[MIGRATE] Stopping instance before changing tags...`;
        const stopResult = await stop(deployment);
        migrationLog += stopResult.log;
        if (stopResult.error) {
            return { error: true, log: migrationLog };
        }

        // Checkout to the target release
        if (targetRelease !== releaseInfo.currentRelease) {
            console.info(`[MIGRATE] Going to git checkout to release ${targetRelease}...`);
            migrationLog += `\n[MIGRATE] Going to git checkout to release ${targetRelease}...`;
        } else {
            console.info(`[MIGRATE] Returning to original branch (release ${targetRelease})...`);
            migrationLog += `\n[MIGRATE] Returning to original branch (release ${targetRelease})...`;
        }

        const checkoutTarget = targetRelease === releaseInfo.currentRelease ? initialBranch : targetRelease;
        const checkoutResult = await checkoutDeploymentTo(deployment, checkoutTarget);
        migrationLog += checkoutResult.log;
        if (checkoutResult.error) {
            return { error: true, log: migrationLog };
        }

        console.info(`[MIGRATE] Deployment is now on ${checkoutTarget}`);
        migrationLog += `\n[MIGRATE] Deployment is now on ${checkoutTarget}`;

        // Build & start the instance
        console.info(`[MIGRATE] Building/starting instance for release ${targetRelease}...`);
        migrationLog += `\n[MIGRATE] Building/starting instance for release ${targetRelease}...`;
        const startResult = await start(deployment, true);
        migrationLog += startResult.log;
        if (startResult.error) {
            return { error: true, log: migrationLog };
        }

        // Run migrations again
        console.info(`[MIGRATE] Running migrations for release ${targetRelease}...`);
        migrationLog += `\n[MIGRATE] Running migrations for release ${targetRelease}...`;
        const migrateResult = await runMigrate(deployment);
        migrationLog += migrateResult.log;
        if (migrateResult.error) {
            // if this happened to throw the incompatible release error again, then we are probably in a bad state. Avoid potential infinite recursion and just fail
            // TODO: once we remove 26.1.0 or newer migrations from the repo, then this will need to be able to do multiple levels of jumping back
            return { error: true, log: migrationLog };
        }
    }

    return { error: false, log: migrationLog };
}
