import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';

/**
 * Runs a command on a deployment's path OUTSIDE OF THE CONTAINER
 * @param {string} cwd Working directory of the deployment where package.json is
 * @param {string} command The command to run using the host system's shell
 * @param {string[]} args Args to be added after the command
 * @returns {Promise<{code: number, stdout: string, stderr: string, log: string}>}
 * @throws {Error} If the process fails to start or the command exits with a non-zero code
 */
export function deploymentExec(cwd, command, args = []) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let combined = '';

        const child = spawn(command, args, { cwd, shell: true });

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
            reject(new Error(`Failed to start process: ${err.message}`));
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
 * Get the version of an RCJ CMS instance
 * Note: for legacy support (versions prior to 26.1.0 without docker),
 * this retrieves the version from the package.json OUTSIDE of the container
 *
 * The version is currently stored in the "version" field of the package.json file
 * If the package.json file doesn't exist, or the version field is missing,
 * then the version is older than 23.8.0 (the first version to include the version field)
 * @param {object} selected_deployment
 * @returns {string|null} The version of the deployment, or null if unknown (< 23.8.0)
 */
export function getDeploymentVersion(selected_deployment) {
    const packageJsonPath = path.join(selected_deployment.path, 'package.json');
    if (!existsSync(packageJsonPath)) {
        return null;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version ?? null;
}

/**
 * Find the list of git tags that are available for the deployment
 * This represents the list of releases that can be switched to when running migrations
 * @param {object} selected_deployment
 * @returns {Promise<string[]>} The list of git tags available for the deployment
 */
export async function getDeploymentTags(selected_deployment) {
    const result = await deploymentExec(selected_deployment.path, 'git', ['tag']);
    return result.stdout.split('\n').filter((tag) => tag !== '');
}

/**
 * Check if the deployment has uncommitted changes
 * @param {object} selected_deployment
 * @returns {Promise<boolean>} True if there are uncommitted changes, false otherwise
 */
export async function deploymentHasUncommittedChanges(selected_deployment) {
    const result = await deploymentExec(selected_deployment.path, 'git', ['status', '--porcelain']);
    return result.stdout.trim() !== '';
}

/**
 * Get the current git branch of the deployment so we can
 * jump back to wherever we were after running migrations
 * @param {object} selected_deployment
 * @param {boolean} useHash Whether to use the hash of the commit instead of the branch name (e.g. if the deployment is in a detached state)
 * @returns {Promise<string>} The current branch name of the deployment (or the commit hash if useHash is true)
 */
export async function getCurrentBranch(selected_deployment, useHash = false) {
    const result = await deploymentExec(
        selected_deployment.path,
        'git',
        useHash ? ['rev-parse', 'HEAD'] : ['rev-parse', '--abbrev-ref', 'HEAD']
    );

    let branchName = result.stdout.trim();

    if (branchName === "HEAD" && !useHash) {
        branchName = await getCurrentBranch(selected_deployment, true);
    }

    return branchName;
}

/**
 * Checkout to a specific tag/branch/hash in the deployment
 * @param {string} deploymentPath The path to the deployment
 * @param {string} target The tag/branch/hash to checkout to
 * @returns {Promise<void>}
 */
export async function checkoutDeploymentTo(deploymentPath, target) {
    await deploymentExec(deploymentPath, 'git', ['checkout', target]);
}
