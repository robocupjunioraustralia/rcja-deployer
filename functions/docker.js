import { spawn } from 'child_process';

/**
 * Runs `docker compose exec -T [<service>] [<command>] [<args>]` in the specified working directory
 *
 * @param {string} cwd Working directory where docker-compose.yml is
 * @param {string} service The service name defined in docker-compose.yml
 * @param {string} command The command to run inside the container
 * @param {string[]} args Args to be added after the command
 * @returns {Promise<{code: number, stdout: string, stderr: string, log: string}>}
 * @throws {Error} If the docker process fails to start or the command exits with a non-zero code
 */
export function dockerComposeExec(cwd, service, command, args = []) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let combined = '';

        const child = spawn(
            'docker',
            ['compose', 'exec', '-T', service, command, ...args],
            { cwd, shell: true },
        );

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            combined += text;
            process.stdout.write(text);
        });

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            combined += text;
            process.stderr.write(text);
        });

        child.on('error', (err) => {
            reject(new Error(`Failed to start docker process: ${err.message}`));
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Command failed with exit code ${code}`));
                return;
            }

            resolve({
                code,
                stdout,
                stderr,
                log: combined,
            });
        });
    });
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
        'app',
        'utils/setup/maintenance.php',
        [enable ? 'on' : 'off']
    );
    console.log(`[MAINTENANCE] Maintenance mode ${enable ? 'enabled' : 'disabled'}`);
}
