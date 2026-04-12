import { deploymentExec } from './deployment';
import type { Deployment, DeploymentExecResult } from './deployment';

const SERVICE_APP = 'app';

/**
 * Start an RCJ CMS instance, optionally building it first
 *
 * @param deployment target
 * @param build Whether to run with --build to ensure the latest code is used
 */
export function start(deployment: Deployment, build: boolean = false): Promise<DeploymentExecResult> {
    return deploymentExec({
        deployment,
        command: 'docker',
        args: ['compose', 'up', '-d', '-V', '--wait', ...(build ? ['--build'] : [])],
        successMessage: `[DOCKER] instance started${build ? ' (and built)' : ''}`
    });
}

/**
 * Stop an RCJ CMS instance
 *
 * @param deployment target
 */
export function stop(deployment: Deployment): Promise<DeploymentExecResult> {
    return deploymentExec({
        deployment,
        command: 'docker',
        args: ['compose', 'down'],
        successMessage: `[DOCKER] instance stopped`
    });
}

/**
 * Change the maintenance state of an RCJ CMS instance
 *
 * @param deployment target
 * @param enable Whether to enable (true) or disable (false) maintenance mode
 */
export function setMaintenanceMode(deployment: Deployment, enable: boolean): Promise<DeploymentExecResult> {
    return deploymentExec({
        deployment,
        command: 'docker',
        args: ['compose', 'exec', '-T', SERVICE_APP, 'php', 'utils/setup/maintenance.php', ...(enable ? ['on'] : ['off'])],
        successMessage: `[DOCKER] Maintenance mode ${enable ? 'enabled' : 'disabled'}`
    });
}

type IncompatibleReleaseError = {
    error: "incompatible_release";
    targetReleases: string[];
    currentRelease: string;
}

/**
 * Run migrations for an RCJ CMS instance
 *
 * @param deployment target
 */
export async function runMigrate(deployment: Deployment): Promise<DeploymentExecResult & {
    incompatibleRelease?: IncompatibleReleaseError
}> {
    const result = await deploymentExec({
        deployment,
        command: 'docker',
        args: ['compose', 'exec', '-T', SERVICE_APP, 'php', 'utils/setup/migrate.php', '--deployer'],
        successMessage: `[DOCKER] Migrations completed successfully`
    });

    if (result.error) {
        /**
         * If the migration script failed, it may be due to attempting to skip multiple versions at a time.
         * In this case, stderr will contain a JSON struct with the releases to go through first
         */
        try {
            const migrateErrorData = JSON.parse(result.stderr) as IncompatibleReleaseError | null;

            if (
                typeof migrateErrorData === 'object' &&
                migrateErrorData !== null &&
                "error" in migrateErrorData &&
                migrateErrorData.error === "incompatible_release"
            ) {
                return {
                    ...result,
                    incompatibleRelease: migrateErrorData
                };
            }
        } catch (err) {
            // assume some other error occured
        }
    }

    return result;
}

/**
 * Backup an RCJ CMS instance
 *
 * @param deployment target
 * @param anonymise Whether to anonymise the backup
 * @param writeStream The stream to write the backup file to
 */
export function backup(deployment: Deployment, anonymise: boolean, writeStream: NodeJS.WritableStream): Promise<DeploymentExecResult> {
    return deploymentExec({
        deployment,
        command: 'docker',
        args: ['compose', 'exec', '-T', SERVICE_APP, 'php', 'utils/setup/backup.php', ...(anonymise ? ['--anonymise'] : [])],
        successMessage: `[DOCKER] Backup completed successfully`,
        pipeStdout: writeStream
    });
}

/**
 * Import a backup to an RCJ CMS instance
 *
 * @param deployment target
 * @param readStream The stream to read the backup file from
 */
export function importBackup(deployment: Deployment, readStream: NodeJS.ReadableStream): Promise<DeploymentExecResult> {
    return deploymentExec({
        deployment,
        command: 'docker',
        args: ['compose', 'exec', '-T', SERVICE_APP, 'php', 'utils/setup/import.php'],
        successMessage: `[DOCKER] Import completed successfully`,
        pipeInput: readStream
    });
}
