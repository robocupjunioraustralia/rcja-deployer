import { deploymentExec } from './deployment';
import type { Deployment, DeploymentExecResult, DeploymentExecError } from './deployment';

const SERVICE_APP = 'app';
const SERVICE_DB = 'db';

/**
 * Runs `docker compose exec -T [<service>] [<command>] [<args>]` in the specified working directory
 *
 * @param deployment target
 * @param service The service name defined in docker-compose.yml
 * @param command The command to run inside the container
 * @param args Args to be added after the command
 * @returns stdout, stderr, and a combined log of both
 * @throws {DeploymentExecError} If the docker process fails to start or the command exits with a non-zero code
 */
export function dockerComposeExec(deployment: Deployment, service: string, command: string, args: string[] = []): Promise<DeploymentExecResult> {
    return deploymentExec(
        deployment,
        'docker',
        ['compose', 'exec', '-T', service, command, ...args]
    );
}

/**
 * Start an RCJ CMS instance, optionally building it first
 *
 * @param deployment target
 * @param build Whether to run with --build to ensure the latest code is used
 */
export async function start(deployment: Deployment, build: boolean = false): Promise<void> {
    await deploymentExec(
        deployment,
        'docker',
        ['compose', 'up', '-d', ...(build ? ['--build'] : [])]
    );
    console.log(`[DOCKER] instance started${build ? ' (and built)' : ''}`);
}

/**
 * Change the maintenance state of an RCJ CMS instance
 *
 * @param deployment target
 * @param enable Whether to enable (true) or disable (false) maintenance mode
 */
export async function setMaintenanceMode(deployment: Deployment, enable: boolean): Promise<void> {
    await dockerComposeExec(
        deployment,
        SERVICE_APP,
        'utils/setup/maintenance.php',
        [enable ? 'on' : 'off']
    );
    console.log(`[DOCKER] Maintenance mode ${enable ? 'enabled' : 'disabled'}`);
}

/**
 * Run migrations for an RCJ CMS instance
 *
 * @param deployment target
 */
export async function runMigrations(deployment: Deployment): Promise<void> {
    await dockerComposeExec(
        deployment,
        SERVICE_APP,
        'utils/setup/migrations.php'
    );
    console.log(`[DOCKER] Migrations completed successfully`);
}
