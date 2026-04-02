import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';

export type DeploymentExecResult = {
    stdout: string;
    stderr: string;
    log: string;
}

export class DeploymentExecError extends Error {
    constructor(message: string, public result: DeploymentExecResult) {
        super(message);
    }
}

export type Deployment = {
    /** name of the deployment */
    title: string;
    /** local path to the deployment files (where docker-compose.yml/package.json is located) */
    path: string;
    /** the folder which contains migration scripts (should be "updates") */
    migration_folder: string;
    /** the prefix of the databases used by the deployment (e.g. "rcj_cms") */
    database_prefix: string;
    /** git repository for the deployment */
    repository: string;
    /** the command to use to pull the latest changes */
    pull_cmd: string;
    /** the npm script to build assets, "build" for dev, "publish" for prod */
    build_cmd: string;
    /** the git ref for confirming the branch sent from the webhook */
    branch_ref?: string;
    /** whether or not to backup the database before running migrations */
    backup?: boolean;
    /** false to include the '--no-dev' flag in the composer install command */
    no_composer_dev?: boolean;
    /** allow this instance to be exported via /export/[deploymentKey] */
    export?: {
        allowed_ips: string[];
        secret: string;
    };
    /** the remote instance details to use when using the import tool */
    import?: {
        remote_host: string;
        deployment: string;
        secret: string;
    };
}

/**
 * Runs a command on a deployment's path OUTSIDE OF THE CONTAINER
 * @param deployment target
 * @param command The command to run using the host system's shell
 * @param args Args to be added after the command
 * @returns stdout, stderr, and a combined log of both
 * @throws {DeploymentExecError} If the process fails to start or the command exits with a non-zero code
 */
export function deploymentExec(deployment: Deployment, command: string, args: string[] = []): Promise<DeploymentExecResult> {
    return new Promise((resolve, reject) => {
        const result: DeploymentExecResult = { stdout: '', stderr: '', log: '' };

        const child = spawn(command, args, { cwd: deployment.path, shell: true });

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            result.stdout += text;
            result.log += text;
            process.stdout.write(text);
        });

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            result.stderr += text;
            result.log += text;
            process.stderr.write(text);
        });

        child.on('error', (err) => {
            reject(new DeploymentExecError(`Failed to start process: ${err.message}`, result));
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new DeploymentExecError(`Command failed with exit code ${code}`, result));
                return;
            }

            resolve(result);
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
 * @param deployment target
 * @returns The version of the deployment, or null if unknown (< 23.8.0)
 */
export function getDeploymentVersion(deployment: Deployment): string | null {
    const packageJsonPath = path.join(deployment.path, 'package.json');
    if (!existsSync(packageJsonPath)) {
        return null;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version ?? null;
}

/**
 * Find the list of git tags that are available for the deployment
 * This represents the list of releases that can be switched to when running migrations
 * @param deployment target
 * @returns The list of git tags available for the deployment
 */
export async function getDeploymentTags(deployment: Deployment): Promise<string[]> {
    const result = await deploymentExec(deployment, 'git', ['tag']);
    return result.stdout.split('\n').filter((tag) => tag !== '');
}

/**
 * Check if the deployment has uncommitted changes
 * @param deployment target
 * @returns True if there are uncommitted changes, false otherwise
 */
export async function deploymentHasUncommittedChanges(deployment: Deployment): Promise<boolean> {
    const result = await deploymentExec(deployment, 'git', ['status', '--porcelain']);
    return result.stdout.trim() !== '';
}

/**
 * Get the current git branch of the deployment so we can
 * jump back to wherever we were after running migrations
 * @param deployment target
 * @param useHash Whether to use the hash of the commit instead of the branch name (e.g. if the deployment is in a detached state)
 * @returns The current branch name of the deployment (or the commit hash if useHash is true)
 */
export async function getCurrentBranch(deployment: Deployment, useHash = false): Promise<string> {
    const result = await deploymentExec(
        deployment,
        'git',
        useHash ? ['rev-parse', 'HEAD'] : ['rev-parse', '--abbrev-ref', 'HEAD']
    );

    let branchName = result.stdout.trim();

    if (branchName === "HEAD" && !useHash) {
        branchName = await getCurrentBranch(deployment, true);
    }

    return branchName;
}

/**
 * Checkout to a specific tag/branch/hash in the deployment
 * @param deployment The deployment to checkout
 * @param target The tag/branch/hash to checkout to
 */
export async function checkoutDeploymentTo(deployment: Deployment, target: string): Promise<void> {
    await deploymentExec(deployment, 'git', ['checkout', target]);
}
