import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';

class DeploymentExecError extends Error {
    constructor(message: string, public result: DeploymentExecResult) {
        super(message);
    }
}

export type DeploymentExecResult = {
    stdout: string;
    stderr: string;
    log: string;
    error: DeploymentExecError | null;
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
    /** whether or not to run the nightly script for this deployment */
    run_nightly?: boolean;
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
 * @returns all deployment configs from deployments.json
 */
export function getAllDeployments(): Record<string, Deployment> {
    const deploymentsConfig = readFileSync(path.join(__dirname, '../deployments.json'), 'utf8');
    const deployments: unknown = JSON.parse(deploymentsConfig);
    if (typeof deployments !== 'object' || deployments === null) {
        throw new Error('Invalid deployments configuration');
    }

    return deployments as Record<string, Deployment>;
}

/**
 * Retrieve deployment config for a given deployment key, or the first deployment if none is given
 * @param deploymentKey The key of the deployment to retrieve (as specified in deployments.json)
 * @param assert Whether to throw an error (true) or return null (false) if the deployment can't be found
 * @returns Deployment config, or null if not found when assert is false
 */
export function getDeployment<TAssert extends boolean = false>(
    deploymentKey?: string,
    assert: TAssert = false as TAssert
): TAssert extends true ? Deployment : Deployment | null {
    const deployments = getAllDeployments();
    const deployment = deploymentKey ? deployments[deploymentKey] : Object.values(deployments)[0];
    if (assert && !deployment) {
        throw new Error(`Deployment with key "${deploymentKey}" not found`);
    }

    return deployment as TAssert extends true ? Deployment : Deployment | null;
}

/**
 * Runs a command on a deployment's path OUTSIDE OF THE CONTAINER
 * @param options
 * @returns success state, stdout, stderr, and a combined log of both
 */
export function deploymentExec(options: {
    deployment: Deployment;
    /** The command to run using the host's system shell */
    command: string;
    /** Args to be added after the command */
    args: string[];
    successMessage?: string;
    errorMessage?: string;
}): Promise<DeploymentExecResult> {
    return new Promise((resolve) => {
        const result: DeploymentExecResult = { stdout: '', stderr: '', log: '', error: null };

        const child = spawn(options.command, options.args, { cwd: options.deployment.path, shell: true });

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
            result.log += `\n[EXEC] Failed to start process: ${err.message}`;
            console.error(`[EXEC] Failed to start process: ${err.message}`);

            if (options.errorMessage) {
                result.log += `\n[EXEC] ${options.errorMessage}`;
                console.error(`[EXEC] ${options.errorMessage}`);
            }

            result.error = new DeploymentExecError(`Failed to start process: ${err.message}`, result);
            resolve(result);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                result.log += `\n[EXEC] Command failed with exit code ${code}`;
                console.error(`[EXEC] Command failed with exit code ${code}`);

                if (options.errorMessage) {
                    result.log += `\n[EXEC] ${options.errorMessage}`;
                    console.error(`[EXEC] ${options.errorMessage}`);
                }

                result.error = new DeploymentExecError(`Command failed with exit code ${code}`, result);
            } else if (options.successMessage) {
                result.log += `\n[EXEC] ${options.successMessage}`;
                console.info(`[EXEC] ${options.successMessage}`);
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
    const result = await deploymentExec({
        deployment,
        command: 'git',
        args: ['tag']
    });
    return result.stdout.split('\n').filter((tag) => tag !== '');
}

/**
 * Check if the deployment has uncommitted changes
 * @param deployment target
 * @returns True if there are uncommitted changes, false otherwise
 */
export async function deploymentHasUncommittedChanges(deployment: Deployment): Promise<boolean> {
    const result = await deploymentExec({
        deployment,
        command: 'git',
        args: ['status', '--porcelain']
    });
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
    const result = await deploymentExec({
        deployment,
        command: 'git',
        args: useHash ? ['rev-parse', 'HEAD'] : ['rev-parse', '--abbrev-ref', 'HEAD']
    });

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
export function checkoutDeploymentTo(deployment: Deployment, target: string): Promise<DeploymentExecResult> {
    return deploymentExec({
        deployment,
        command: 'git',
        args: ['checkout', target]
    });
}
