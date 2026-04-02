import { deploymentExec } from './deployment';

const SERVICE_APP = 'app';
const SERVICE_DB = 'db';

/**
 * Runs `docker compose exec -T [<service>] [<command>] [<args>]` in the specified working directory
 *
 * @param {string} cwd Working directory of the deployment where docker-compose.yml is
 * @param {string} service The service name defined in docker-compose.yml
 * @param {string} command The command to run inside the container
 * @param {string[]} args Args to be added after the command
 * @returns {Promise<{code: number, stdout: string, stderr: string, log: string}>}
 * @throws {Error} If the docker process fails to start or the command exits with a non-zero code
 */
export function dockerComposeExec(cwd, service, command, args = []) {
    return deploymentExec(
        cwd,
        'docker',
        ['compose', 'exec', '-T', service, command, ...args]
    );
}

/**
 * Start an RCJ CMS instance, optionally building it first
 *
 * @param {object} selected_deployment
 * @param {boolean} build Whether to run with --build to ensure the latest code is used
 * @returns {Promise<void>}
 */
export async function start(selected_deployment, build) {
    await dockerComposeExec(
        selected_deployment.path,
        SERVICE_APP,
        'utils/setup/migrations.php',
        build ? ['--build'] : []
    );
    console.log(`[DOCKER] instance started${build ? ' (and built)' : ''}`);
}

/**
 * Change the maintenance state of an RCJ CMS instance
 *
 * @param {object} selected_deployment
 * @param {boolean} enable Whether to enable (true) or disable (false) maintenance mode
 * @returns {Promise<void>}
 */
export async function setMaintenanceMode(selected_deployment, enable) {
    await dockerComposeExec(
        selected_deployment.path,
        SERVICE_APP,
        'utils/setup/maintenance.php',
        [enable ? 'on' : 'off']
    );
    console.log(`[DOCKER] Maintenance mode ${enable ? 'enabled' : 'disabled'}`);
}

/**
 * Run migrations for an RCJ CMS instance
 *
 * @param {object} selected_deployment
 * @returns {Promise<void>}
 */
export async function runMigrations(selected_deployment) {
    await dockerComposeExec(
        selected_deployment.path,
        SERVICE_APP,
        'utils/setup/migrations.php'
    );
    console.log(`[DOCKER] Migrations completed successfully`);
}
