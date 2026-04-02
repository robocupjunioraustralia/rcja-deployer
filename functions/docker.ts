import { deploymentExec } from './deployment';
import type { Deployment, DeploymentExecResult } from './deployment';

const SERVICE_APP = 'app';
const SERVICE_DB = 'db';

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
        args: ['compose', 'up', '-d', ...(build ? ['--build'] : [])],
        successMessage: `[DOCKER] instance started${build ? ' (and built)' : ''}`
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
        args: ['compose', 'exec', '-T', SERVICE_APP, 'utils/setup/maintenance.php', ...(enable ? ['on'] : ['off'])],
        successMessage: `[DOCKER] Maintenance mode ${enable ? 'enabled' : 'disabled'}`
    });
}

/**
 * Run migrations for an RCJ CMS instance
 *
 * @param deployment target
 */
export async function runMigrations(deployment: Deployment): Promise<DeploymentExecResult> {
    return deploymentExec({
        deployment,
        command: 'docker',
        args: ['compose', 'exec', '-T', SERVICE_APP, 'utils/setup/migrations.php'],
        successMessage: `[DOCKER] Migrations completed successfully`
    });
}

/**
 * Rebuild views for an RCJ CMS instance
 *
 * @param deployment target
 */
export async function rebuildViews(deployment: Deployment): Promise<DeploymentExecResult> {
    return deploymentExec({
        deployment,
        command: 'docker',
        args: ['compose', 'exec', '-T', SERVICE_APP, 'utils/setup/rebuildViews.php'],
        successMessage: `[DOCKER] Views rebuilt successfully`
    });
}
